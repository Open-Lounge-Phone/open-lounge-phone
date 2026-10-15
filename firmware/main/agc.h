// The handset mic's automatic gain control (docs/audio.md, item 1): a slow digital gain after the
// ADC that brings speech to about -24 dBFS. It only follows frames that look like speech (above a
// level gate over the noise floor, which it measures in the first second and then tracks), so
// silences keep the gain they had and room hiss isn't pumped up. A peak limiter at -3 dBFS keeps
// loud bursts from clipping. Pure C (no ESP-IDF): unit-tested on the host.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define AGC_TARGET_DBFS (-24.0f)
#define AGC_MIN_GAIN_DB (-6.0f)
#define AGC_MAX_GAIN_DB (18.0f)
#define AGC_LIMIT_DBFS (-3.0f)
#define AGC_GATE_DB 10.0f      // speech: this far above the noise floor…
#define AGC_SILENCE_DBFS (-70.0f)  // …and above this (no gain for a dead line)

typedef struct {
  int rate;
  float gain_db;      // the gain now (it ramps to the next value over each frame)
  float floor_db;     // the noise floor
  float speech_db;    // the input speech level (fast up, slow down)
  bool have_speech;
  uint32_t frames;    // frames seen
  float limit;        // the limiter's gain (linear, 1 = not limiting)
  float limit_release;  // per sample
  bool speech;        // the last frame passed the gate
  float in_db, out_db;  // the last frame's levels (for the phone check and the log)
} agc_t;

void agc_init(agc_t *a, int rate);
/** One frame (any length; the audio task uses 20 ms), in place. */
void agc_process(agc_t *a, int16_t *pcm, size_t n);
/**
 * The phone check's word for the handset mic, from the speech level at the ADC (before the AGC)
 * and the loudest sample: "TOO LOUD" (the ADC clips: less analog gain), "WEAK" (quieter than the
 * AGC can lift to the target), else "OK".
 */
const char *agc_verdict(float speech_in_dbfs, float peak_dbfs);
