// The audio device behind the call: the ES8311 codec on the board, or a test device (a 1 kHz
// source and an analysing sink) so the WebRTC path runs without the codec (the simulator,
// bring-up). 16 kHz, 16-bit mono, 20 ms frames (dsp.h).
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

typedef struct {
  const char *name;
  /** Samples per read/write (the DMA block): 16 (1 ms) on the codec, a 20 ms frame on the test
   * device. The sidetone's delay is a block in and `tx_blocks` blocks queued out. */
  size_t block;
  size_t tx_blocks;
  esp_err_t (*init)(void);
  /** Earpiece path on/off (off = DAC muted, clocks may stop). */
  void (*speaker)(bool on);
  /** Mic capture on/off: off = the ADC is muted and no samples are read (only in a call). */
  void (*mic)(bool on);
  /** Earpiece volume in dB (<= 0; the caller applies the cap). */
  void (*volume_db)(float db);
  /** Blocks until `n` mic samples are read (paces the pump). Returns the count read. */
  int (*read)(int16_t *pcm, size_t n);
  /** Plays `n` samples to the earpiece. */
  void (*write)(const int16_t *pcm, size_t n);
} audio_dev_t;

extern const audio_dev_t audio_dev_es8311;
extern const audio_dev_t audio_dev_test;

/** True if the ES8311 answers on I2C (probe only). */
bool audio_es8311_present(void);

/** Mic gain for tuning on a board: analog PGA 0-30 dB (3 dB steps) and the ADC's digital
 * scale-up 0-42 dB (6 dB steps). Applies now if the mic is on, else when it next turns on. */
void audio_es8311_mic_gain(int pga_db, int scale_db);

/** The test device's sink: what the earpiece "heard" in the last second. */
typedef struct {
  float rms_dbfs;      // overall level
  float tone_dbfs;     // at the frequency being watched (audio_test_watch)
  float watch_hz;
} audio_test_sink_t;
void audio_test_watch(float hz);
/** The test device's "mic": a tone at `hz` (default 1 kHz). */
void audio_test_source(float hz);
audio_test_sink_t audio_test_sink(void);
