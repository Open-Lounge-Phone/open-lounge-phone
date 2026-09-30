// Small, pure audio helpers (no ESP-IDF): G.711 mu-law, call-progress tones, levels and a
// Goertzel tone detector. Unit-tested on the host (firmware/test/host).
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define DSP_RATE 8000       // the call's sample rate (G.711)
#define DSP_FRAME 160       // 20 ms at 8 kHz

// --- G.711 mu-law (PCMU, RTP payload type 0) -----------------------------------------------
uint8_t dsp_ulaw_encode(int16_t pcm);
int16_t dsp_ulaw_decode(uint8_t ulaw);
void dsp_ulaw_encode_buf(const int16_t *pcm, uint8_t *out, size_t n);
void dsp_ulaw_decode_buf(const uint8_t *in, int16_t *pcm, size_t n);

// --- Call-progress tones (packages/client/src/tones.ts: North American plan) ---------------
typedef enum {
  TONE_NONE,
  TONE_DIAL,      // 350 + 440 Hz, continuous
  TONE_RINGBACK,  // 440 + 480 Hz, 2 s on / 4 s off
  TONE_BUSY,      // 480 + 620 Hz, 0.5 s on / 0.5 s off
  TONE_HOLD,      // 440 Hz, 0.25 s every 4 s
  TONE_TEST,      // 1 kHz, continuous (bring-up and the simulator's test source)
} tone_t;

typedef struct {
  tone_t tone;
  uint32_t phase[2];   // Q32 phase accumulators
  uint32_t step[2];
  int nfreq;
  uint32_t pos;        // samples since the tone started
  uint32_t on, period; // cadence in samples (on == period: continuous)
  int16_t amp;         // peak amplitude of each sine
} tone_gen_t;

void tone_start(tone_gen_t *g, tone_t tone, int16_t amp);
/** Adds (mixes) the tone into `pcm` (saturating). Returns true if any sample was non-zero. */
bool tone_mix(tone_gen_t *g, int16_t *pcm, size_t n);
const char *tone_name(tone_t t);

// --- Levels ---------------------------------------------------------------------------------
/** RMS level in dBFS (full-scale sine = -3 dBFS); -100 for silence. */
float dsp_rms_dbfs(const int16_t *pcm, size_t n);
/** Power at `freq` Hz (Goertzel) in dBFS: a full-scale sine at `freq` reads about -3. */
float dsp_goertzel_dbfs(const int16_t *pcm, size_t n, float freq, float rate);
/** Level and tone meter over windows of `len` samples, fed frame by frame (no sample buffer). */
typedef struct {
  double sumsq, s1, s2, coeff;
  uint32_t n, len;
  float hz;
  float rms_dbfs, tone_dbfs;  // results of the last complete window (-100 until then)
} dsp_meter_t;
void dsp_meter_init(dsp_meter_t *m, float hz, uint32_t len);
/** Returns true when a window completed (rms_dbfs / tone_dbfs updated). */
bool dsp_meter_feed(dsp_meter_t *m, const int16_t *pcm, size_t n);
/** Scale by a gain in dB (<= 0 attenuates), saturating. */
void dsp_gain(int16_t *pcm, size_t n, float db);
