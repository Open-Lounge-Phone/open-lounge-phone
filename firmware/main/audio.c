#include "audio.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "agc.h"
#include "audio_dev.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
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
static tone_t s_forced_tone;  // bring-up: `audio tone` (plays even on the hook)
static audio_stats_t s_stats = {.mic_dbfs = -100, .mic_peak_dbfs = -100, .rx_dbfs = -100,
                                .rx_tone_dbfs = -100, .watch_hz = 440, .speech_in_dbfs = -100,
                                .speech_out_dbfs = -100};

// Task-only state.
static tone_gen_t s_tone;
static voice_tx_t s_vtx;  // the call's codec, both ways (voice.h)
static voice_rx_t s_vrx;
static rs_t s_rec_rs, s_play_rs;  // 16 ↔ 8 kHz for voicemail and greetings
static uint32_t s_enc_us, s_enc_max_us, s_dec_us, s_dec_max_us, s_codec_frames;
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

/** The Opus states in internal RAM when there's room (faster than PSRAM). */
void *voice_alloc(size_t size) {
  void *p = heap_caps_malloc(size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  return p ? p : heap_caps_malloc(size, MALLOC_CAP_8BIT);
}

void voice_free(void *p) { heap_caps_free(p); }

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

static void task(void *arg) {
  int16_t mic[DSP_FRAME], out[DSP_FRAME];
  uint8_t pkt[VOICE_MAX_PACKET];
  uint32_t pts = 0;
  bool codecs_open = false;
  voice_codec_t tx_now = VOICE_PCMU, rx_now = VOICE_PCMU;
  tone_t tone_now = TONE_NONE;
  bool mic_now = false, speaker_now = false;
  int64_t last_log = 0;
  for (;;) {
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
    s_volume_dirty = false;
    taskEXIT_CRITICAL(&s_lock);

    // Privacy: the mic is on only in a call with media (or the explicit loopback test).
    // Muted (MENU 3): the codec's mic is switched off too, not just left out.
    bool mic_want = (call && !held && !muted) || loop_ms > 0 || rec || listen;
    if (mic_want != mic_now) {
      s_dev->mic(mic_want);
      mic_now = mic_want;
      if (mic_now) {
        agc_init(&s_agc, DSP_RATE);  // learns this call's noise floor afresh
        s_speech_frames = 0;
        s_speech_in = s_speech_out = 0;
      }
    }
    bool speaker_want = offhook || loop_ms > 0 || forced || play;
    if (speaker_want != speaker_now) {
      s_dev->speaker(speaker_want);
      speaker_now = speaker_want;
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

    if (!mic_now && !speaker_now) {
      // Hung up and nothing to play: sleep (the I2S DMA plays silence by itself).
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }
    if (mic_now) {
      s_dev->read(mic, DSP_FRAME);
      measure(&s_mic_meter, mic, DSP_FRAME, false);  // the level from the ADC (before the AGC)
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
    }
    if (call && sender) {
      // On hold or muted: silence keeps the connection alive.
      if (held || muted || !mic_now) memset(mic, 0, sizeof mic);
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

    memset(out, 0, sizeof out);
    if (loop_ms > 0) {
      if (!s_ring) s_ring = heap_caps_calloc(RING, sizeof(int16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
      if (!s_ring) s_ring = calloc(RING, sizeof(int16_t));
      if (s_ring) {
        taskENTER_CRITICAL(&s_lock);
        ring_push(mic, DSP_FRAME);
        taskEXIT_CRITICAL(&s_lock);
        ring_pop(out, DSP_FRAME, (size_t)loop_ms * DSP_RATE / 1000);
      }
    } else if (call) {
      if (call_frame(out)) measure(&s_rx_meter, out, DSP_FRAME, true);
      if (held) memset(out, 0, sizeof out);
    }
    if (play) {
      taskENTER_CRITICAL(&s_lock);
      int16_t nb[NB_FRAME] = {0};  // voicemail is 8 kHz WAV
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
    s_dev->write(out, DSP_FRAME);  // blocks ~20 ms

    if (call) {
      int64_t now = (int64_t)xTaskGetTickCount() * portTICK_PERIOD_MS;
      if (now - last_log >= 5000) {
        last_log = now;
        audio_stats_t st = audio_stats();
        uint32_t frames = s_codec_frames ? s_codec_frames : 1;
        // CPU per 20 ms frame: encode (the mic) and decode (the call), average and worst.
        ESP_LOGI(TAG, "AUDIO tx=%lu rx=%lu rxbytes=%lu under=%lu conceal=%lu fec=%lu late=%lu "
                 "jb=%d jit=%.0f miclevel=%.1f agc=%.1f speech=%.1f rxlevel=%.1f rx%.0fHz=%.1f "
                 "codec=%s/%s enc=%lu/%luus dec=%lu/%luus stack=%u",
                 (unsigned long)st.tx_frames, (unsigned long)st.rx_frames,
                 (unsigned long)st.rx_bytes, (unsigned long)st.underruns,
                 (unsigned long)st.concealed, (unsigned long)s_vrx.fec_frames,
                 (unsigned long)st.late, st.jb_target_ms, st.jitter_ms, st.mic_dbfs,
                 st.agc_gain_db, st.speech_out_dbfs, st.rx_dbfs, st.watch_hz, st.rx_tone_dbfs,
                 voice_codec_name(s_vtx.codec), voice_codec_name(s_vrx.codec),
                 (unsigned long)(s_enc_us / frames), (unsigned long)s_enc_max_us,
                 (unsigned long)(s_dec_us / frames), (unsigned long)s_dec_max_us,
                 (unsigned)uxTaskGetStackHighWaterMark(NULL));
        s_enc_us = s_enc_max_us = s_dec_us = s_dec_max_us = s_codec_frames = 0;
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
    nvs_close(h);
  }
  ESP_LOGI(TAG, "audio device: %s; volume %d/%d (%.0f dBFS, cap %d dBFS)", s_dev->name, s_volume,
           VOLUME_MAX, audio_volume_db(s_volume), CONFIG_OLP_EARPIECE_MAX_DB);
  // Opus encodes on this task's stack (libopus's scratch arrays): AUDIO stack= shows what's left.
  xTaskCreatePinnedToCore(task, "audio", 40960, NULL, 7, NULL, 1);
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
         "rxlevel=%.1f rx%.0fHz=%.1f",
         audio_device_name(), st.in_call, s_volume, VOLUME_MAX, audio_volume_db(s_volume),
         (unsigned long)st.tx_frames, (unsigned long)st.rx_frames, (unsigned long)st.rx_bytes,
         (unsigned long)st.underruns, (unsigned long)st.drops, (unsigned long)st.concealed,
         (unsigned long)st.late, st.jb_target_ms, st.jitter_ms, st.mic_dbfs, st.mic_peak_dbfs,
         st.agc_gain_db, s_agc_on ? "on" : "off", st.speech_in_dbfs, st.speech_out_dbfs,
         st.rx_dbfs, st.watch_hz, st.rx_tone_dbfs);
  if (s_dev == &audio_dev_test)
    printf(" earpiece=%.1f earpiece%.0fHz=%.1f", sink.rms_dbfs, sink.watch_hz, sink.tone_dbfs);
  printf("\n");
}
