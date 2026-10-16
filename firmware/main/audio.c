#include "audio.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "agc.h"
#include "audio_dev.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "echo.h"
#include "fifo.h"
#include "jbuf.h"
#include "resample.h"
#include "voice.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "sdkconfig.h"

static const char *TAG = "audio";
#define NS "olp"
#define RING (DSP_RATE / 2)   // the loopback test's delay line (500 ms; allocated when used)
#define NB_FRAME (DSP_FRAME / 2)  // 20 ms at 8 kHz (voicemail and greetings)
#define TONE_AMP 6000         // per sine: -18 dBFS each, like the web phone's quiet tones

static const audio_dev_t *s_dev;
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;

// Shared state (s_lock).
static jbuf_t s_jb;  // the call's received packets (docs/audio.md item 4)
static int16_t *s_ring;
static size_t s_head, s_fill;  // write position = (s_head + s_fill) % RING
static bool s_playing;
static bool s_offhook, s_call, s_held, s_muted, s_listen;
static int16_t *s_rec_buf;  // leaving a voicemail: the mic goes here (no call needed)
static const int16_t *s_play_buf;  // playing a voicemail to the earpiece
static size_t s_play_len, s_play_pos;
static size_t s_rec_max, s_rec_len;
static tone_t s_tone_want;
static audio_sender_t s_sender;
static voice_codec_t s_tx_codec, s_rx_codec;  // what the call sends / receives
static int s_volume = VOLUME_DEFAULT;
static bool s_volume_dirty = true;
static int s_loop_ms;
static sidetone_t s_sidetone = SIDETONE_NORMAL;
static bool s_sidetone_slow;  // the echo test measured more than 5 ms mic to ear: no sidetone
#if CONFIG_OLP_ECHO_CANCEL
static bool s_echo_cancel = true;
#else
static bool s_echo_cancel = false;
#endif
// The phone check's echo test (MENU 7 2): a sweep out, the mic and what was played kept.
static volatile int s_et_state;  // 0 idle, 1 running, 2 measuring, 3 done
static int16_t *s_et_mic, *s_et_ref;
static size_t s_et_len, s_et_got, s_et_played;
static echo_result_t s_et_result;
static tone_t s_forced_tone;  // bring-up: `audio tone` (plays even on the hook)
static audio_stats_t s_stats = {.mic_dbfs = -100, .mic_peak_dbfs = -100, .rx_dbfs = -100,
                                .rx_tone_dbfs = -100, .watch_hz = 440, .speech_in_dbfs = -100,
                                .speech_out_dbfs = -100};

// Task-only state.
static tone_gen_t s_tone;
static voice_tx_t s_vtx;  // the call's codec, both ways (voice.h)
static voice_rx_t s_vrx;
static rs_t s_rec_rs, s_play_rs;  // 16 ↔ 8 kHz for voicemail and greetings
static echo_t s_echo;             // the call's echo meter and (when on) canceller
static bool s_echo_open;
static uint32_t s_enc_us, s_enc_max_us, s_dec_us, s_dec_max_us, s_codec_frames;
static uint32_t s_aec_us, s_aec_max_us;
static agc_t s_agc;  // the mic's automatic gain (item 1 of docs/audio.md)
static bool s_agc_on = CONFIG_OLP_MIC_AGC;
static int s_speech_frames;             // speech frames in the current one-second window…
static float s_speech_in, s_speech_out;  // …and their summed levels (dBFS)
static dsp_meter_t s_rx_meter, s_mic_meter;  // one-second windows
static int s_mic_peak;                          // the loudest mic sample in the current window

const char *audio_device_name(void) { return s_dev ? s_dev->name : "none"; }

float audio_volume_db(int level) {
  if (level < 0) level = 0;
  if (level > VOLUME_MAX) level = VOLUME_MAX;
  return (float)CONFIG_OLP_EARPIECE_MAX_DB - 3.0f * (VOLUME_MAX - level);
}

static void ring_push(const int16_t *pcm, size_t n) {
  // caller holds s_lock
  for (size_t i = 0; i < n; i++) {
    if (s_fill == RING) {  // full: drop the oldest
      s_head = (s_head + 1) % RING;
      s_fill--;
      s_stats.drops++;
    }
    s_ring[(s_head + s_fill) % RING] = pcm[i];
    s_fill++;
  }
}

/** Pops a frame if playing; returns false (silence) while buffering or on underrun. */
static bool ring_pop(int16_t *pcm, size_t n, size_t start_fill) {
  bool ok = false;
  taskENTER_CRITICAL(&s_lock);
  if (!s_playing && s_fill >= start_fill) s_playing = true;
  if (s_playing && s_fill >= n) {
    for (size_t i = 0; i < n; i++) pcm[i] = s_ring[(s_head + i) % RING];
    s_head = (s_head + n) % RING;
    s_fill -= n;
    ok = true;
  } else if (s_playing) {
    s_playing = false;  // underrun: buffer up again
  }
  taskEXIT_CRITICAL(&s_lock);
  return ok;
}

static void ring_reset(void) {
  taskENTER_CRITICAL(&s_lock);
  s_head = s_fill = 0;
  s_playing = false;
  taskEXIT_CRITICAL(&s_lock);
}

void audio_rx_packet(const uint8_t *data, size_t n, uint32_t pts_ms) {
  int64_t now = esp_timer_get_time() / 1000;
  taskENTER_CRITICAL(&s_lock);
  if (s_call) {
    jb_put(&s_jb, pts_ms, data, n, now);
    s_stats.rx_bytes += n;
    s_stats.rx_frames++;
  }
  taskEXIT_CRITICAL(&s_lock);
}

/** The next 20 ms of the call: a packet decoded, or a lost one concealed (voice.c). */
static bool call_frame(int16_t *out) {
  uint8_t pkt[JB_MAX_PACKET], next[JB_MAX_PACKET];
  size_t len = 0, next_len = 0;
  taskENTER_CRITICAL(&s_lock);
  jb_out_t o = jb_get(&s_jb);
  if (o.kind == JB_PACKET) {
    len = o.len;
    memcpy(pkt, o.data, len);
  } else if (o.kind == JB_LOST && o.next) {
    next_len = o.next_len;
    memcpy(next, o.next, next_len);
  }
  taskEXIT_CRITICAL(&s_lock);
  if (o.kind == JB_WAIT) {
    memset(out, 0, DSP_FRAME * sizeof *out);
    return false;
  }
  int64_t t0 = esp_timer_get_time();
  if (o.kind == JB_LOST) voice_conceal(&s_vrx, next_len ? next : NULL, next_len, out);
  else voice_decode(&s_vrx, pkt, len, out);
  uint32_t us = (uint32_t)(esp_timer_get_time() - t0);
  s_dec_us += us;
  if (us > s_dec_max_us) s_dec_max_us = us;
  return true;
}

/** The Opus states (about 40 KB) in PSRAM: internal RAM is what the call's network needs. */
void *voice_alloc(size_t size) {
  void *p = heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  return p ? p : heap_caps_malloc(size, MALLOC_CAP_8BIT);
}

void voice_free(void *p) { heap_caps_free(p); }

/** The echo canceller's states (tens of KB) in PSRAM: internal RAM is for the network. */
void *echo_alloc(size_t size) {
  void *p = heap_caps_calloc(1, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  return p ? p : heap_caps_calloc(1, size, MALLOC_CAP_8BIT);
}

void echo_free(void *p) { heap_caps_free(p); }

static void measure(dsp_meter_t *m, const int16_t *pcm, size_t n, bool rx) {
  taskENTER_CRITICAL(&s_lock);
  float hz = s_stats.watch_hz;
  taskEXIT_CRITICAL(&s_lock);
  if (m->hz != hz) dsp_meter_init(m, hz, DSP_RATE);
  if (!rx) {
    for (size_t i = 0; i < n; i++) {
      int a = pcm[i] < 0 ? -(int)pcm[i] : pcm[i];
      if (a > s_mic_peak) s_mic_peak = a;
    }
  }
  if (!dsp_meter_feed(m, pcm, n)) return;
  float peak = s_mic_peak > 0 ? 20.0f * log10f((float)s_mic_peak / 32768.0f) : -100.0f;
  if (!rx) s_mic_peak = 0;
  taskENTER_CRITICAL(&s_lock);
  if (rx) {
    s_stats.rx_dbfs = m->rms_dbfs;
    s_stats.rx_tone_dbfs = m->tone_dbfs;
  } else {
    s_stats.mic_dbfs = m->rms_dbfs;
    s_stats.mic_peak_dbfs = peak;
  }
  taskEXIT_CRITICAL(&s_lock);
}

/** The AGC on a mic frame, and the speech levels it saw (the phone check shows them). */
static void mic_gain(int16_t *pcm, size_t n) {
  if (s_agc_on) {
    agc_process(&s_agc, pcm, n);
  } else {  // off (`audio agc off`): it still measures, on a copy
    int16_t copy[DSP_FRAME];
    size_t k = n > DSP_FRAME ? DSP_FRAME : n;
    memcpy(copy, pcm, k * sizeof *copy);
    agc_process(&s_agc, copy, k);
  }
  if (s_agc.speech) {
    s_speech_frames++;
    s_speech_in += s_agc.in_db;
    s_speech_out += s_agc.out_db;
  }
  if (s_agc.frames % (DSP_RATE / DSP_FRAME) != 0) return;  // once a second
  int64_t now = esp_timer_get_time() / 1000;
  taskENTER_CRITICAL(&s_lock);
  s_stats.agc_gain_db = s_agc.gain_db;
  if (s_speech_frames > 0) {
    s_stats.speech_in_dbfs = s_speech_in / (float)s_speech_frames;
    s_stats.speech_out_dbfs = s_speech_out / (float)s_speech_frames;
    s_stats.speech_ms = now;
  }
  taskEXIT_CRITICAL(&s_lock);
  s_speech_frames = 0;
  s_speech_in = s_speech_out = 0;
}

void audio_agc(bool on) {
  s_agc_on = on;
  ESP_LOGI(TAG, "mic AGC %s", on ? "on" : "off");
}

bool audio_agc_on(void) { return s_agc_on; }

void audio_rx_codec(voice_codec_t codec) {
  taskENTER_CRITICAL(&s_lock);
  s_rx_codec = codec;
  taskEXIT_CRITICAL(&s_lock);
}

void audio_record(int16_t *buf, size_t max_samples) {
  rs_init(&s_rec_rs);
  taskENTER_CRITICAL(&s_lock);
  s_rec_buf = buf;
  s_rec_max = buf ? max_samples : 0;
  s_rec_len = 0;
  taskEXIT_CRITICAL(&s_lock);
}

size_t audio_recorded(void) {
  taskENTER_CRITICAL(&s_lock);
  size_t n = s_rec_len;
  taskEXIT_CRITICAL(&s_lock);
  return n;
}

size_t audio_record_stop(void) {
  taskENTER_CRITICAL(&s_lock);
  size_t n = s_rec_len;
  s_rec_buf = NULL;
  s_rec_max = 0;
  taskEXIT_CRITICAL(&s_lock);
  return n;
}

void audio_play(const int16_t *samples, size_t count) {
  taskENTER_CRITICAL(&s_lock);
  s_play_buf = samples;
  s_play_len = samples ? count : 0;
  s_play_pos = 0;
  taskEXIT_CRITICAL(&s_lock);
}

size_t audio_played(void) {
  taskENTER_CRITICAL(&s_lock);
  size_t n = s_play_pos;
  taskEXIT_CRITICAL(&s_lock);
  return n;
}

void audio_hold(bool held) {
  taskENTER_CRITICAL(&s_lock);
  s_held = held;
  taskEXIT_CRITICAL(&s_lock);
}

void audio_mute(bool muted) {
  taskENTER_CRITICAL(&s_lock);
  s_muted = muted;
  taskEXIT_CRITICAL(&s_lock);
}

void audio_listen(bool on) {
  taskENTER_CRITICAL(&s_lock);
  if (on && !s_listen) {  // a fresh reading
    s_stats.mic_dbfs = s_stats.mic_peak_dbfs = -100;
    s_stats.speech_in_dbfs = s_stats.speech_out_dbfs = -100;
    s_stats.speech_ms = 0;
  }
  s_listen = on;
  taskEXIT_CRITICAL(&s_lock);
}

/** The call's codecs changed (or it started): open them afresh. */
static void open_codecs(voice_codec_t tx, voice_codec_t rx) {
  voice_tx_close(&s_vtx);
  voice_rx_close(&s_vrx);
  if (!voice_tx_open(&s_vtx, tx)) ESP_LOGW(TAG, "%s encoder failed: sending PCMU", voice_codec_name(tx));
  if (!voice_rx_open(&s_vrx, rx)) ESP_LOGW(TAG, "%s decoder failed", voice_codec_name(rx));
  s_enc_us = s_enc_max_us = s_dec_us = s_dec_max_us = s_codec_frames = 0;
  ESP_LOGI(TAG, "call codec: send %s, receive %s (16 kHz audio)", voice_codec_name(s_vtx.codec),
           voice_codec_name(s_vrx.codec));
}

// --- the pump: the I2S side, a block at a time --------------------------------------------
// The codec's DMA runs in small blocks (1 ms on the board) so the sidetone, mixed in here, stays
// under 5 ms: a 20 ms frame would be heard as an echo. The pump hands the mic to the audio task
// and plays what it's given, through FIFOs; the audio task does everything 20 ms at a time.

#define FIFO_CAP 2048                 // samples (128 ms at 16 kHz), a power of two
// Keep 15 ms queued for the earpiece (the audio task's slack); a device with 20 ms blocks (the
// test device) needs a whole block more.
#define SPK_TARGET (s_dev->block >= DSP_FRAME ? 2 * DSP_FRAME : DSP_FRAME * 3 / 4)
static int16_t s_mic_buf[FIFO_CAP], s_ref_buf[FIFO_CAP], s_spk_buf[FIFO_CAP];
static fifo_t s_mic_fifo, s_ref_fifo, s_spk_fifo;  // pump → task (mic, what it played), task → pump
static TaskHandle_t s_dsp_task;
// What the pump does (set by the audio task).
static volatile bool s_pump_mic, s_pump_speaker;
static volatile int32_t s_sidetone_q15;  // 0 = none
static volatile uint32_t s_pump_under;   // blocks the earpiece ran dry (while it played)
static int64_t s_silence_at_us;          // muted / on hold: the next silent packet

static void pump(void *arg) {
  const size_t B = s_dev->block;
  int16_t mic[DSP_FRAME], out[DSP_FRAME];
  bool notified_low = false;
  for (;;) {
    bool mic_on = s_pump_mic, spk_on = s_pump_speaker;
    if (!mic_on && !spk_on) {
      vTaskDelay(pdMS_TO_TICKS(20));  // the DMA plays silence by itself
      continue;
    }
    if (mic_on) s_dev->read(mic, B);  // paces the loop (one block)
    uint32_t got = fifo_read(&s_spk_fifo, out, (uint32_t)B);
    if (got < B) {
      memset(out + got, 0, (B - got) * sizeof *out);
      if (spk_on) s_pump_under++;
    }
    if (mic_on) {
      // The pair the echo canceller needs: what was heard and what was played, block by block.
      fifo_write(&s_mic_fifo, mic, (uint32_t)B);
      fifo_write(&s_ref_fifo, out, (uint32_t)B);
      dsp_sidetone_mix(out, mic, B, s_sidetone_q15);
    }
    s_dev->write(out, B);  // paces the loop when the mic is off
    bool low = fifo_level(&s_spk_fifo) < SPK_TARGET;
    if ((mic_on && fifo_level(&s_mic_fifo) >= DSP_FRAME) || (low && !notified_low)) {
      xTaskNotifyGive(s_dsp_task);
    }
    notified_low = low;
  }
}

/** The earpiece's next 20 ms: the call (or the loopback test), a voicemail, a tone. */
static void speaker_frame(int16_t *out, const int16_t *mic, bool call, bool held, bool play,
                          int loop_ms) {
  memset(out, 0, DSP_FRAME * sizeof *out);
  if (s_et_state == 1) {  // the echo test's sweep, nothing else
    for (int i = 0; i < DSP_FRAME; i++) out[i] = echo_test_sample(s_et_played++, DSP_RATE);
    return;
  }
  if (loop_ms > 0) {
    if (!s_ring) s_ring = heap_caps_calloc(RING, sizeof(int16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_ring) s_ring = calloc(RING, sizeof(int16_t));
    if (s_ring && mic) {
      taskENTER_CRITICAL(&s_lock);
      ring_push(mic, DSP_FRAME);
      taskEXIT_CRITICAL(&s_lock);
      ring_pop(out, DSP_FRAME, (size_t)loop_ms * DSP_RATE / 1000);
    }
  } else if (call) {
    if (call_frame(out)) measure(&s_rx_meter, out, DSP_FRAME, true);
    if (held) memset(out, 0, DSP_FRAME * sizeof *out);
  }
  if (play) {
    int16_t nb[NB_FRAME] = {0};  // voicemail is 8 kHz WAV
    taskENTER_CRITICAL(&s_lock);
    bool first = s_play_pos == 0;
    if (s_play_buf) {
      size_t n = s_play_len - s_play_pos < NB_FRAME ? s_play_len - s_play_pos : NB_FRAME;
      memcpy(nb, s_play_buf + s_play_pos, n * sizeof(int16_t));
      s_play_pos += n;
    }
    taskEXIT_CRITICAL(&s_lock);
    if (first) rs_init(&s_play_rs);
    rs_up(&s_play_rs, nb, NB_FRAME, out);
  }
  tone_mix(&s_tone, out, DSP_FRAME);
}

/** The echo test: keeps the mic and what was played, side by side. */
static void echo_test_keep(const int16_t *mic, const int16_t *ref) {
  size_t n = s_et_len - s_et_got < DSP_FRAME ? s_et_len - s_et_got : DSP_FRAME;
  memcpy(s_et_mic + s_et_got, mic, n * sizeof *mic);
  memcpy(s_et_ref + s_et_got, ref, n * sizeof *ref);
  s_et_got += n;
  if (s_et_got >= s_et_len) s_et_state = 2;  // measured below (the task, between frames)
}

/** The test's numbers, from what was kept: the loss, the delay, and what follows from them. */
static volatile bool s_persist_pending;

static void echo_test_finish(void) {
  // The sweep reached the earpiece a little after it was made (the earpiece's queue): line the
  // kept audio up with the test's timeline first.
  size_t q = (size_t)DSP_RATE * ECHO_TEST_QUIET_MS / 1000, first = 0;
  while (first < s_et_got && !s_et_ref[first]) first++;
  size_t shift = first > q ? first - q : 0;
  size_t n = s_et_got - shift;
  s_et_result = echo_test_measure(s_et_ref + shift, s_et_mic + shift, n, DSP_RATE);
  heap_caps_free(s_et_mic);
  heap_caps_free(s_et_ref);
  s_et_mic = s_et_ref = NULL;
  echo_result_t r = s_et_result;
  ESP_LOGI(TAG, "ECHOTEST heard=%d erl=%.1f delay=%.1fms noise=%.1f (%s)", r.heard, r.erl_db,
           r.delay_ms, r.noise_dbfs, echo_word(r.erl_db));
  // Earpiece to mic is the sidetone's path too: over 5 ms it would sound like an echo.
  if (r.heard && r.delay_ms > 5.0f) {
    s_sidetone_slow = true;
    ESP_LOGW(TAG, "sidetone off: %.1f ms mic to ear (over 5 ms)", r.delay_ms);
  }
  if (r.erl_db < ECHO_POOR_DB && !s_echo_cancel) {
    s_echo_cancel = true;  // from the next call
    ESP_LOGI(TAG, "ECHO CANCEL on (the echo test found poor loss)");
  }
  // Saved by audio_persist() on the main task: this task's stack is in PSRAM, which must not
  // be in use while flash is written.
  s_persist_pending = true;
  s_et_state = 3;
}

void audio_persist(void) {
  if (!s_persist_pending) return;
  s_persist_pending = false;
  nvs_handle_t h;
  if (nvs_open(NS, NVS_READWRITE, &h) == ESP_OK) {
    nvs_set_u8(h, "st_slow", s_sidetone_slow);
    nvs_set_u8(h, "echo", s_echo_cancel);
    nvs_commit(h);
    nvs_close(h);
  }
}

static void task(void *arg) {
  int16_t mic[DSP_FRAME], ref[DSP_FRAME], out[DSP_FRAME];
  uint8_t pkt[VOICE_MAX_PACKET];
  uint32_t pts = 0;
  bool codecs_open = false;
  voice_codec_t tx_now = VOICE_PCMU, rx_now = VOICE_PCMU;
  tone_t tone_now = TONE_NONE;
  bool mic_now = false, speaker_now = false;
  int64_t last_log = 0;
  for (;;) {
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(20));
    taskENTER_CRITICAL(&s_lock);
    bool call = s_call, offhook = s_offhook, vol_dirty = s_volume_dirty, held = s_held;
    bool muted = s_muted, listen = s_listen;
    bool rec = s_rec_buf != NULL;
    bool play = s_play_buf != NULL;
    tone_t want = s_forced_tone != TONE_NONE ? s_forced_tone : s_tone_want;
    bool forced = s_forced_tone != TONE_NONE;
    audio_sender_t sender = s_sender;
    voice_codec_t tx_want = s_tx_codec, rx_want = s_rx_codec;
    int loop_ms = s_loop_ms, volume = s_volume;
    sidetone_t sidetone = s_sidetone;
    s_volume_dirty = false;
    taskEXIT_CRITICAL(&s_lock);

    // Privacy: the mic is on only in a call with media (or the explicit loopback test).
    // Muted (MENU 3): the codec's mic is switched off too, not just left out.
    bool testing = s_et_state == 1;
    bool mic_want = (call && !held && !muted) || loop_ms > 0 || rec || listen || testing;
    bool speaker_want = offhook || loop_ms > 0 || forced || play || testing;
    if (mic_want != mic_now) {
      s_pump_mic = false;  // the pump stops reading before the codec's mic changes
      s_dev->mic(mic_want);
      mic_now = mic_want;
      fifo_reset(&s_mic_fifo);
      fifo_reset(&s_ref_fifo);
      if (mic_now) {
        agc_init(&s_agc, DSP_RATE);  // learns this call's noise floor afresh
        s_speech_frames = 0;
        s_speech_in = s_speech_out = 0;
      }
      s_pump_mic = mic_now;
    }
    if (speaker_want != speaker_now) {
      s_dev->speaker(speaker_want);
      speaker_now = speaker_want;
      s_pump_speaker = speaker_now;
    }
    // Sidetone: your own voice in the earpiece, only in a connected call, never while muted.
    s_sidetone_q15 = call && mic_now && !muted && !held && speaker_now && !s_sidetone_slow
                         ? dsp_gain_q15(dsp_sidetone_db(sidetone))
                         : 0;
    // The echo meter (and canceller) for a call's mic.
    bool want_echo = call && mic_now;
    if (want_echo && !s_echo_open) {
      if (!echo_open(&s_echo, DSP_RATE, DSP_FRAME, s_echo_cancel)) {
        ESP_LOGW(TAG, "echo canceller: no memory; measuring only");
        echo_open(&s_echo, DSP_RATE, DSP_FRAME, false);
      }
      s_echo_open = true;
      ESP_LOGI(TAG, "echo canceller %s", s_echo.aec ? "on" : "off (measuring the echo only)");
    } else if (!want_echo && s_echo_open) {
      echo_close(&s_echo);
      s_echo_open = false;
    }
    if (vol_dirty) s_dev->volume_db(audio_volume_db(volume));
    if (want != tone_now) {
      tone_start(&s_tone, want, TONE_AMP);
      tone_now = want;
    }
    if (call && (!codecs_open || tx_want != tx_now || rx_want != rx_now)) {
      open_codecs(tx_want, rx_want);
      codecs_open = true;
      tx_now = tx_want;
      rx_now = rx_want;
    } else if (!call && codecs_open) {
      voice_tx_close(&s_vtx);
      voice_rx_close(&s_vrx);
      codecs_open = false;
    }
    if (!mic_now && !speaker_now) continue;

    // The earpiece first (decoding is quick), so it never runs dry while the mic is coded.
    if (!mic_now) {
      while (speaker_now && fifo_level(&s_spk_fifo) < SPK_TARGET) {
        speaker_frame(out, NULL, call, held, play, loop_ms);
        fifo_write(&s_spk_fifo, out, DSP_FRAME);
      }
      // A call muted or on hold has no mic: its packets still go out (silence), 20 ms apart.
      int64_t now_us = esp_timer_get_time();
      if (call && sender && now_us >= s_silence_at_us) {
        s_silence_at_us = now_us + 20000;
        memset(mic, 0, sizeof mic);
        size_t n = voice_encode(&s_vtx, mic, pkt, sizeof pkt);
        if (n) sender(pkt, n, pts);
        pts += DSP_FRAME * 1000 / DSP_RATE;
        taskENTER_CRITICAL(&s_lock);
        s_stats.tx_frames++;
        taskEXIT_CRITICAL(&s_lock);
      }
      continue;
    }
    while (fifo_level(&s_mic_fifo) >= DSP_FRAME) {
      fifo_read(&s_mic_fifo, mic, DSP_FRAME);
      fifo_read(&s_ref_fifo, ref, DSP_FRAME);
      if (fifo_level(&s_spk_fifo) < SPK_TARGET + DSP_FRAME) {
        speaker_frame(out, mic, call, held, play, loop_ms);
        fifo_write(&s_spk_fifo, out, DSP_FRAME);
      }
      measure(&s_mic_meter, mic, DSP_FRAME, false);  // the level from the ADC (before the AGC)
      // The reference as the earpiece played it: after the codec's volume.
      float vg = powf(10.0f, audio_volume_db(volume) / 20.0f);
      for (int i = 0; i < DSP_FRAME; i++) ref[i] = (int16_t)lrintf((float)ref[i] * vg);
      if (s_et_state == 1 && s_et_mic) echo_test_keep(mic, ref);
      if (s_echo_open) {
        int64_t t0 = esp_timer_get_time();
        echo_process(&s_echo, mic, ref);  // before the AGC: the echo path is linear there
        uint32_t us = (uint32_t)(esp_timer_get_time() - t0);
        s_aec_us += us;
        if (us > s_aec_max_us) s_aec_max_us = us;
      }
      mic_gain(mic, DSP_FRAME);
      if (rec) {
        int16_t nb[NB_FRAME];  // voicemail is 8 kHz WAV
        rs_down(&s_rec_rs, mic, DSP_FRAME, nb);
        taskENTER_CRITICAL(&s_lock);
        if (s_rec_buf) {
          size_t n = s_rec_max - s_rec_len < NB_FRAME ? s_rec_max - s_rec_len : NB_FRAME;
          memcpy(s_rec_buf + s_rec_len, nb, n * sizeof(int16_t));
          s_rec_len += n;
        }
        taskEXIT_CRITICAL(&s_lock);
      }
      if (call && sender) {
        // On hold or muted: silence keeps the connection alive.
        if (held || muted) memset(mic, 0, sizeof mic);
        int64_t t0 = esp_timer_get_time();
        size_t n = voice_encode(&s_vtx, mic, pkt, sizeof pkt);
        uint32_t us = (uint32_t)(esp_timer_get_time() - t0);
        s_enc_us += us;
        if (us > s_enc_max_us) s_enc_max_us = us;
        s_codec_frames++;
        if (n) sender(pkt, n, pts);
        taskENTER_CRITICAL(&s_lock);
        s_stats.tx_frames++;
        taskEXIT_CRITICAL(&s_lock);
      }
      pts += DSP_FRAME * 1000 / DSP_RATE;
    }

    if (s_et_state == 2) echo_test_finish();
    if (call) {
      int64_t now = esp_timer_get_time() / 1000;
      if (now - last_log >= 5000) {
        last_log = now;
        audio_stats_t st = audio_stats();
        uint32_t frames = s_codec_frames ? s_codec_frames : 1;
        // CPU per 20 ms frame: encode (the mic) and decode (the call), average and worst.
        ESP_LOGI(TAG, "AUDIO tx=%lu rx=%lu rxbytes=%lu under=%lu conceal=%lu fec=%lu late=%lu "
                 "jb=%d jit=%.0f miclevel=%.1f agc=%.1f speech=%.1f rxlevel=%.1f rx%.0fHz=%.1f "
                 "codec=%s/%s enc=%lu/%luus dec=%lu/%luus aec=%lu/%luus erl=%.0f erlbest=%.0f "
                 "erle=%.0f aecreset=%lu stack=%u dry=%lu heap=%u",
                 (unsigned long)st.tx_frames, (unsigned long)st.rx_frames,
                 (unsigned long)st.rx_bytes, (unsigned long)st.underruns,
                 (unsigned long)st.concealed, (unsigned long)s_vrx.fec_frames,
                 (unsigned long)st.late, st.jb_target_ms, st.jitter_ms, st.mic_dbfs,
                 st.agc_gain_db, st.speech_out_dbfs, st.rx_dbfs, st.watch_hz, st.rx_tone_dbfs,
                 voice_codec_name(s_vtx.codec), voice_codec_name(s_vrx.codec),
                 (unsigned long)(s_enc_us / frames), (unsigned long)s_enc_max_us,
                 (unsigned long)(s_dec_us / frames), (unsigned long)s_dec_max_us,
                 (unsigned long)(s_aec_us / frames), (unsigned long)s_aec_max_us, s_echo.erl_db,
                 s_echo.erl_best_db, s_echo.erle_db, (unsigned long)echo_warnings(),
                 (unsigned)uxTaskGetStackHighWaterMark(NULL), (unsigned long)s_pump_under,
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
        s_enc_us = s_enc_max_us = s_dec_us = s_dec_max_us = s_codec_frames = 0;
        s_aec_us = s_aec_max_us = 0;
      }
    }
  }
}

void audio_start(bool force_test_device) {
  s_dev = &audio_dev_test;
  if (!force_test_device && audio_dev_es8311.init() == ESP_OK) s_dev = &audio_dev_es8311;
  else audio_dev_test.init();
  nvs_handle_t h;
  if (nvs_open(NS, NVS_READONLY, &h) == ESP_OK) {
    uint8_t v;
    if (nvs_get_u8(h, "volume", &v) == ESP_OK && v <= VOLUME_MAX) s_volume = v;
    if (nvs_get_u8(h, "sidetone", &v) == ESP_OK && v < SIDETONE_LEVELS) s_sidetone = (sidetone_t)v;
    if (nvs_get_u8(h, "echo", &v) == ESP_OK) s_echo_cancel = v != 0;
    if (nvs_get_u8(h, "st_slow", &v) == ESP_OK) s_sidetone_slow = v != 0;
    nvs_close(h);
  }
  ESP_LOGI(TAG, "audio device: %s; volume %d/%d (%.0f dBFS, cap %d dBFS)", s_dev->name, s_volume,
           VOLUME_MAX, audio_volume_db(s_volume), CONFIG_OLP_EARPIECE_MAX_DB);
  fifo_init(&s_mic_fifo, s_mic_buf, FIFO_CAP);
  fifo_init(&s_ref_fifo, s_ref_buf, FIFO_CAP);
  fifo_init(&s_spk_fifo, s_spk_buf, FIFO_CAP);
  // Opus encodes on this task's stack (libopus's scratch arrays): AUDIO stack= shows what's left.
  // 36 KB (libopus needs most of it): in PSRAM, so internal RAM stays for Wi-Fi, lwIP and TLS.
  // This task never writes flash (audio_persist does, on the main task).
  if (xTaskCreatePinnedToCoreWithCaps(task, "audio", 36864, NULL, 7, &s_dsp_task, 1,
                                      MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) != pdPASS) {
    xTaskCreatePinnedToCore(task, "audio", 36864, NULL, 7, &s_dsp_task, 1);
  }
  xTaskCreatePinnedToCore(pump, "audio_io", 3072, NULL, 12, NULL, 1);
  ESP_LOGI(TAG, "sidetone %s (%.0f dB; %d-sample blocks, about %.1f ms mic to ear%s); echo "
           "canceller %s", sidetone_name(s_sidetone), dsp_sidetone_db(s_sidetone),
           (int)s_dev->block, audio_sidetone_latency_ms(),
           s_sidetone_slow ? "; off: measured over 5 ms" : "", s_echo_cancel ? "on" : "off");
}

void audio_set_offhook(bool up) {
  taskENTER_CRITICAL(&s_lock);
  s_offhook = up;
  taskEXIT_CRITICAL(&s_lock);
}

void audio_set_tone(tone_t tone) {
  taskENTER_CRITICAL(&s_lock);
  bool changed = s_tone_want != tone;
  s_tone_want = tone;
  taskEXIT_CRITICAL(&s_lock);
  if (changed) ESP_LOGI(TAG, "TONE %s", tone_name(tone));
}

void audio_force_tone(tone_t tone) {
  taskENTER_CRITICAL(&s_lock);
  s_forced_tone = tone;
  taskEXIT_CRITICAL(&s_lock);
  ESP_LOGI(TAG, "bring-up tone %s", tone_name(tone));
}

void audio_call(bool on, voice_codec_t codec, audio_sender_t sender) {
  taskENTER_CRITICAL(&s_lock);
  bool changed = s_call != on;
  s_call = on;
  s_sender = on ? sender : NULL;
  if (on && changed) s_tx_codec = s_rx_codec = codec;
  if (on) s_tx_codec = codec;
  if (changed && on) {
    jb_init(&s_jb);
    s_pump_under = 0;
    s_echo.erl_db = s_echo.erl_best_db = -1;
    s_stats.tx_frames = s_stats.rx_frames = s_stats.rx_bytes = 0;
    s_stats.underruns = s_stats.drops = 0;
    s_stats.mic_dbfs = s_stats.rx_dbfs = s_stats.rx_tone_dbfs = -100;
  }
  s_stats.in_call = on;
  taskEXIT_CRITICAL(&s_lock);
  if (changed) {
    ring_reset();
    ESP_LOGI(TAG, "call media %s", on ? "on (mic on)" : "off (mic off)");
  }
}

void audio_set_volume(int level) {
  if (level < 0) level = 0;
  if (level > VOLUME_MAX) level = VOLUME_MAX;
  taskENTER_CRITICAL(&s_lock);
  s_volume = level;
  s_volume_dirty = true;
  taskEXIT_CRITICAL(&s_lock);
  nvs_handle_t h;
  if (nvs_open(NS, NVS_READWRITE, &h) == ESP_OK) {
    nvs_set_u8(h, "volume", (uint8_t)level);
    nvs_commit(h);
    nvs_close(h);
  }
  ESP_LOGI(TAG, "VOLUME %d/%d (%.0f dBFS)", level, VOLUME_MAX, audio_volume_db(level));
}

int audio_volume(void) { return s_volume; }

const char *sidetone_name(sidetone_t level) {
  static const char *names[] = {"off", "low", "normal"};
  return level < SIDETONE_LEVELS ? names[level] : "?";
}

void audio_set_sidetone(sidetone_t level) {
  if (level >= SIDETONE_LEVELS) level = SIDETONE_NORMAL;
  taskENTER_CRITICAL(&s_lock);
  s_sidetone = level;
  taskEXIT_CRITICAL(&s_lock);
  nvs_handle_t h;
  if (nvs_open(NS, NVS_READWRITE, &h) == ESP_OK) {
    nvs_set_u8(h, "sidetone", (uint8_t)level);
    nvs_commit(h);
    nvs_close(h);
  }
  ESP_LOGI(TAG, "SIDETONE %s (%.0f dB)", sidetone_name(level), dsp_sidetone_db(level));
}

sidetone_t audio_sidetone(void) { return s_sidetone; }
bool audio_sidetone_slow(void) { return s_sidetone_slow; }

void audio_set_echo_cancel(bool on) {
  s_echo_cancel = on;  // from the next call
  nvs_handle_t h;
  if (nvs_open(NS, NVS_READWRITE, &h) == ESP_OK) {
    nvs_set_u8(h, "echo", on);
    nvs_commit(h);
    nvs_close(h);
  }
  ESP_LOGI(TAG, "ECHO CANCEL %s (from the next call)", on ? "on" : "off");
}

bool audio_echo_cancel(void) { return s_echo_cancel; }

bool audio_echo_test(void) {
  if (s_et_state == 1 || s_et_state == 2) return false;
  taskENTER_CRITICAL(&s_lock);
  bool busy = s_call;
  taskEXIT_CRITICAL(&s_lock);
  if (busy) return false;
  s_et_len = echo_test_len(DSP_RATE) + DSP_RATE / 10;  // and the earpiece's queue
  s_et_mic = heap_caps_malloc(s_et_len * sizeof(int16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  s_et_ref = heap_caps_malloc(s_et_len * sizeof(int16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!s_et_mic) s_et_mic = malloc(s_et_len * sizeof(int16_t));
  if (!s_et_ref) s_et_ref = malloc(s_et_len * sizeof(int16_t));
  if (!s_et_mic || !s_et_ref) {
    heap_caps_free(s_et_mic);
    heap_caps_free(s_et_ref);
    s_et_mic = s_et_ref = NULL;
    return false;
  }
  s_et_got = s_et_played = 0;
  s_sidetone_slow = false;  // measured afresh
  s_et_state = 1;
  ESP_LOGI(TAG, "ECHOTEST started");
  return true;
}

int audio_echo_test_state(echo_result_t *r) {
  if (r) *r = s_et_result;
  return s_et_state;
}

float audio_sidetone_latency_ms(void) {
  // A block coming in, the blocks queued for the DMA going out, and the codec's ADC and DAC
  // filters (about 1 ms together at 16 kHz). The echo test measures the real thing.
  if (!s_dev) return 0;
  return 1000.0f * (float)(s_dev->block * (1 + s_dev->tx_blocks)) / DSP_RATE + 1.0f;
}

void audio_loopback(int delay_ms) {
  if (delay_ms < 0) delay_ms = 0;
  if (delay_ms > 400) delay_ms = 400;  // the ring holds 500 ms
  ring_reset();
  taskENTER_CRITICAL(&s_lock);
  s_loop_ms = delay_ms;
  taskEXIT_CRITICAL(&s_lock);
  ESP_LOGI(TAG, "loopback %s (%d ms)", delay_ms ? "on" : "off", delay_ms);
}

audio_stats_t audio_stats(void) {
  taskENTER_CRITICAL(&s_lock);
  s_stats.concealed = s_jb.concealed;
  s_stats.late = s_jb.late;
  s_stats.underruns = s_jb.rebuffers;
  s_stats.drops = s_jb.dropped;
  s_stats.jb_target_ms = s_jb.target_ms;
  s_stats.jitter_ms = s_jb.jitter_ms;
  audio_stats_t st = s_stats;
  taskEXIT_CRITICAL(&s_lock);
  return st;
}

void audio_watch(float hz) {
  taskENTER_CRITICAL(&s_lock);
  s_stats.watch_hz = hz;
  taskEXIT_CRITICAL(&s_lock);
  audio_test_watch(hz);
}

void audio_print_status(void) {
  audio_stats_t st = audio_stats();
  audio_test_sink_t sink = audio_test_sink();
  printf("AUDIO device=%s call=%d volume=%d/%d(%.0fdBFS) tx=%lu rx=%lu rxbytes=%lu under=%lu "
         "drops=%lu conceal=%lu late=%lu jb=%d jit=%.0f miclevel=%.1f micpeak=%.1f agc=%.1f(%s) speechin=%.1f speech=%.1f "
         "rxlevel=%.1f rx%.0fHz=%.1f aecon=%d erl=%.0f erle=%.0f sidetone=%s",
         audio_device_name(), st.in_call, s_volume, VOLUME_MAX, audio_volume_db(s_volume),
         (unsigned long)st.tx_frames, (unsigned long)st.rx_frames, (unsigned long)st.rx_bytes,
         (unsigned long)st.underruns, (unsigned long)st.drops, (unsigned long)st.concealed,
         (unsigned long)st.late, st.jb_target_ms, st.jitter_ms, st.mic_dbfs, st.mic_peak_dbfs,
         st.agc_gain_db, s_agc_on ? "on" : "off", st.speech_in_dbfs, st.speech_out_dbfs,
         st.rx_dbfs, st.watch_hz, st.rx_tone_dbfs, s_echo_open && s_echo.aec, s_echo.erl_db,
         s_echo.erle_db, s_sidetone_slow ? "off(slow)" : sidetone_name(s_sidetone));
  if (s_dev == &audio_dev_test)
    printf(" earpiece=%.1f earpiece%.0fHz=%.1f", sink.rms_dbfs, sink.watch_hz, sink.tone_dbfs);
  printf("\n");
}
