// The test audio device: the "mic" is a 1 kHz tone at about -12 dBFS and the "earpiece" measures
// what it is given (level, and the power at a watched frequency, once a second). Time is paced
// with the RTOS tick, 20 ms per frame, like the I2S DMA on the board. Used by the simulator build
// and by `audio test` on a board for bring-up without a handset.
#include <string.h>

#include "audio_dev.h"
#include "dsp.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static tone_gen_t s_src;
static bool s_mic_on, s_speaker_on;
static float s_volume_db;
static TickType_t s_last;
static dsp_meter_t s_meter;  // the earpiece, one-second windows
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static audio_test_sink_t s_sink = {.rms_dbfs = -100, .tone_dbfs = -100, .watch_hz = 440};

static esp_err_t init(void) {
  tone_start(&s_src, TONE_TEST, 8192);  // 8192/32768 peak → -15 dBFS RMS
  s_last = xTaskGetTickCount();
  return ESP_OK;
}

static void speaker(bool on) { s_speaker_on = on; }
static void mic(bool on) { s_mic_on = on; }
static void volume_db(float db) { s_volume_db = db; }

static int read_pcm(int16_t *pcm, size_t n) {
  memset(pcm, 0, n * sizeof *pcm);
  if (!s_mic_on) return 0;
  tone_mix(&s_src, pcm, n);
  return (int)n;
}

static void write_pcm(const int16_t *pcm, size_t n) {
  // What reaches the "earpiece": after the codec's volume, and nothing on the hook (muted).
  int16_t buf[DSP_FRAME];
  size_t k = n > DSP_FRAME ? DSP_FRAME : n;
  memcpy(buf, pcm, k * sizeof *buf);
  if (!s_speaker_on) memset(buf, 0, sizeof buf);
  dsp_gain(buf, k, s_volume_db);
  taskENTER_CRITICAL(&s_lock);
  float hz = s_sink.watch_hz;
  taskEXIT_CRITICAL(&s_lock);
  if (s_meter.hz != hz || s_meter.len == 0) dsp_meter_init(&s_meter, hz, DSP_RATE);
  if (dsp_meter_feed(&s_meter, buf, k)) {
    taskENTER_CRITICAL(&s_lock);
    s_sink.rms_dbfs = s_meter.rms_dbfs;
    s_sink.tone_dbfs = s_meter.tone_dbfs;
    taskEXIT_CRITICAL(&s_lock);
  }
  // Pace like the DMA: one frame per 20 ms. If the (simulated) CPU fell behind, start again
  // from now instead of racing to catch up (that would starve the idle task).
  TickType_t period = pdMS_TO_TICKS(n * 1000 / DSP_RATE);
  if (xTaskGetTickCount() - s_last > 5 * period) s_last = xTaskGetTickCount();
  if (xTaskDelayUntil(&s_last, period) == pdFALSE) vTaskDelay(1);
}

void audio_test_watch(float hz) {
  taskENTER_CRITICAL(&s_lock);
  s_sink.watch_hz = hz;
  taskEXIT_CRITICAL(&s_lock);
}

audio_test_sink_t audio_test_sink(void) {
  taskENTER_CRITICAL(&s_lock);
  audio_test_sink_t r = s_sink;
  taskEXIT_CRITICAL(&s_lock);
  return r;
}

const audio_dev_t audio_dev_test = {
    .name = "test",
    .init = init,
    .speaker = speaker,
    .mic = mic,
    .volume_db = volume_db,
    .read = read_pcm,
    .write = write_pcm,
};
