#include "audio.h"

#include <stdio.h>
#include <string.h>

#include "audio_dev.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "sdkconfig.h"

static const char *TAG = "audio";
#define NS "olp"
#define RING 4000             // 500 ms of received audio
#define START_FILL 480        // start playing after 60 ms buffered (jitter)
#define MAX_FILL 2400         // over 300 ms buffered: drop down to START_FILL (latency cap)
#define TONE_AMP 6000         // per sine: -18 dBFS each, like the web phone's quiet tones

static const audio_dev_t *s_dev;
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;

// Shared state (s_lock).
static int16_t s_ring[RING];
static size_t s_head, s_fill;  // write position = (s_head + s_fill) % RING
static bool s_playing;
static bool s_offhook, s_call;
static tone_t s_tone_want;
static audio_sender_t s_sender;
static int s_volume = VOLUME_DEFAULT;
static bool s_volume_dirty = true;
static int s_loop_ms;
static tone_t s_forced_tone;  // bring-up: `audio tone` (plays even on the hook)
static audio_stats_t s_stats = {.mic_dbfs = -100, .rx_dbfs = -100, .rx_tone_dbfs = -100,
                                .watch_hz = 440};

// Task-only state.
static tone_gen_t s_tone;
static dsp_meter_t s_rx_meter, s_mic_meter;  // one-second windows

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
  if (s_fill > MAX_FILL) {
    size_t drop = s_fill - START_FILL;
    s_head = (s_head + drop) % RING;
    s_fill -= drop;
    s_stats.drops += drop;
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
    s_stats.underruns++;
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

void audio_rx_ulaw(const uint8_t *data, size_t n) {
  int16_t pcm[DSP_FRAME];
  while (n > 0) {
    size_t k = n > DSP_FRAME ? DSP_FRAME : n;
    dsp_ulaw_decode_buf(data, pcm, k);
    taskENTER_CRITICAL(&s_lock);
    if (s_call) {
      ring_push(pcm, k);
      s_stats.rx_bytes += k;
    }
    taskEXIT_CRITICAL(&s_lock);
    data += k;
    n -= k;
  }
  taskENTER_CRITICAL(&s_lock);
  if (s_call) s_stats.rx_frames++;
  taskEXIT_CRITICAL(&s_lock);
}

static void measure(dsp_meter_t *m, const int16_t *pcm, size_t n, bool rx) {
  taskENTER_CRITICAL(&s_lock);
  float hz = s_stats.watch_hz;
  taskEXIT_CRITICAL(&s_lock);
  if (m->hz != hz) dsp_meter_init(m, hz, DSP_RATE);
  if (!dsp_meter_feed(m, pcm, n)) return;
  taskENTER_CRITICAL(&s_lock);
  if (rx) {
    s_stats.rx_dbfs = m->rms_dbfs;
    s_stats.rx_tone_dbfs = m->tone_dbfs;
  } else {
    s_stats.mic_dbfs = m->rms_dbfs;
  }
  taskEXIT_CRITICAL(&s_lock);
}

static void task(void *arg) {
  int16_t mic[DSP_FRAME], out[DSP_FRAME];
  uint8_t ulaw[DSP_FRAME];
  uint32_t pts = 0;
  tone_t tone_now = TONE_NONE;
  bool mic_now = false, speaker_now = false;
  int64_t last_log = 0;
  for (;;) {
    taskENTER_CRITICAL(&s_lock);
    bool call = s_call, offhook = s_offhook, vol_dirty = s_volume_dirty;
    tone_t want = s_forced_tone != TONE_NONE ? s_forced_tone : s_tone_want;
    bool forced = s_forced_tone != TONE_NONE;
    audio_sender_t sender = s_sender;
    int loop_ms = s_loop_ms, volume = s_volume;
    s_volume_dirty = false;
    taskEXIT_CRITICAL(&s_lock);

    // Privacy: the mic is on only in a call with media (or the explicit loopback test).
    bool mic_want = call || loop_ms > 0;
    if (mic_want != mic_now) {
      s_dev->mic(mic_want);
      mic_now = mic_want;
    }
    bool speaker_want = offhook || loop_ms > 0 || forced;
    if (speaker_want != speaker_now) {
      s_dev->speaker(speaker_want);
      speaker_now = speaker_want;
    }
    if (vol_dirty) s_dev->volume_db(audio_volume_db(volume));
    if (want != tone_now) {
      tone_start(&s_tone, want, TONE_AMP);
      tone_now = want;
    }

    if (!mic_now && !speaker_now) {
      // Hung up and nothing to play: sleep (the I2S DMA plays silence by itself).
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }
    if (mic_now) {
      s_dev->read(mic, DSP_FRAME);
      measure(&s_mic_meter, mic, DSP_FRAME, false);
    }
    if (call && sender) {
      dsp_ulaw_encode_buf(mic, ulaw, DSP_FRAME);
      sender(ulaw, DSP_FRAME, pts);
      taskENTER_CRITICAL(&s_lock);
      s_stats.tx_frames++;
      taskEXIT_CRITICAL(&s_lock);
    }
    pts += DSP_FRAME * 1000 / DSP_RATE;

    memset(out, 0, sizeof out);
    if (loop_ms > 0) {
      taskENTER_CRITICAL(&s_lock);
      ring_push(mic, DSP_FRAME);
      taskEXIT_CRITICAL(&s_lock);
      ring_pop(out, DSP_FRAME, (size_t)loop_ms * DSP_RATE / 1000);
    } else if (call) {
      if (ring_pop(out, DSP_FRAME, START_FILL)) measure(&s_rx_meter, out, DSP_FRAME, true);
    }
    tone_mix(&s_tone, out, DSP_FRAME);
    s_dev->write(out, DSP_FRAME);  // blocks ~20 ms

    if (call) {
      int64_t now = (int64_t)xTaskGetTickCount() * portTICK_PERIOD_MS;
      if (now - last_log >= 5000) {
        last_log = now;
        audio_stats_t st = audio_stats();
        ESP_LOGI(TAG, "AUDIO tx=%lu rx=%lu rxbytes=%lu under=%lu miclevel=%.1f rxlevel=%.1f rx%.0fHz=%.1f",
                 (unsigned long)st.tx_frames, (unsigned long)st.rx_frames,
                 (unsigned long)st.rx_bytes, (unsigned long)st.underruns, st.mic_dbfs, st.rx_dbfs,
                 st.watch_hz, st.rx_tone_dbfs);
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
  xTaskCreatePinnedToCore(task, "audio", 4096, NULL, 7, NULL, 1);
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

void audio_call(bool on, audio_sender_t sender) {
  taskENTER_CRITICAL(&s_lock);
  bool changed = s_call != on;
  s_call = on;
  s_sender = on ? sender : NULL;
  if (changed && on) {
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
         "drops=%lu miclevel=%.1f rxlevel=%.1f rx%.0fHz=%.1f",
         audio_device_name(), st.in_call, s_volume, VOLUME_MAX, audio_volume_db(s_volume),
         (unsigned long)st.tx_frames, (unsigned long)st.rx_frames, (unsigned long)st.rx_bytes,
         (unsigned long)st.underruns, (unsigned long)st.drops, st.mic_dbfs, st.rx_dbfs,
         st.watch_hz, st.rx_tone_dbfs);
  if (s_dev == &audio_dev_test)
    printf(" earpiece=%.1f earpiece%.0fHz=%.1f", sink.rms_dbfs, sink.watch_hz, sink.tone_dbfs);
  printf("\n");
}
