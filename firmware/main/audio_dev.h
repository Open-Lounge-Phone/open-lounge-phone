// The audio device behind the call: the ES8311 codec on the board, or a test device (a 1 kHz
// source and an analysing sink) so the WebRTC path runs without the codec (the simulator,
// bring-up). 8 kHz, 16-bit mono, 20 ms frames (dsp.h).
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

typedef struct {
  const char *name;
  esp_err_t (*init)(void);
  /** Earpiece path on/off (off = DAC muted, clocks may stop). */
  void (*speaker)(bool on);
  /** Mic capture on/off: off = the ADC is muted and no samples are read (only in a call). */
  void (*mic)(bool on);
  /** Earpiece volume in dB (<= 0; the caller applies the cap). */
  void (*volume_db)(float db);
  /** Blocks until `n` mic samples are read (paces the audio task). Returns the count read. */
  int (*read)(int16_t *pcm, size_t n);
  /** Plays `n` samples to the earpiece. */
  void (*write)(const int16_t *pcm, size_t n);
} audio_dev_t;

extern const audio_dev_t audio_dev_es8311;
extern const audio_dev_t audio_dev_test;

/** True if the ES8311 answers on I2C (probe only). */
bool audio_es8311_present(void);

/** The test device's sink: what the earpiece "heard" in the last second. */
typedef struct {
  float rms_dbfs;      // overall level
  float tone_dbfs;     // at the frequency being watched (audio_test_watch)
  float watch_hz;
} audio_test_sink_t;
void audio_test_watch(float hz);
audio_test_sink_t audio_test_sink(void);
