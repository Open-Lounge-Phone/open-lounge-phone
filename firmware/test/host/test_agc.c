#include <stdlib.h>

#include "agc.h"
#include "check.h"

#define RATE 16000
#define FRAME 320

// Speech-like test audio: a 150 Hz voice with harmonics and a 4 Hz syllable envelope, in bursts
// (1.2 s talking, 0.4 s pause), over steady noise at -65 dBFS. `level` is the RMS of the talking
// parts in dBFS.
typedef struct {
  float level;
  uint32_t n;
  uint32_t seed;
} talker_t;

static float noise(uint32_t *seed) {
  *seed = *seed * 1664525u + 1013904223u;
  return ((float)(*seed >> 8) / 16777216.0f - 0.5f) * 3.4641f;  // unit RMS
}

static bool talking_at(uint32_t n) { return n % (RATE * 16 / 10) < RATE * 12 / 10; }

static void talk(talker_t *t, int16_t *out, size_t len) {
  // A harmonic voice of unit RMS before the envelope: 1/k amplitudes for 6 harmonics.
  static float norm;
  if (!norm) {
    float s = 0;
    for (int k = 1; k <= 6; k++) s += 0.5f / (float)(k * k);
    norm = 1.0f / sqrtf(s);
  }
  for (size_t i = 0; i < len; i++, t->n++) {
    float x = 0;
    if (talking_at(t->n)) {
      float ph = 6.2831853f * 150.0f * (float)t->n / RATE;
      for (int k = 1; k <= 6; k++) x += sinf(ph * (float)k) / (float)k;
      float env = 0.65f + 0.35f * sinf(6.2831853f * 4.0f * (float)t->n / RATE);
      x *= norm * env / 0.6955f;  // the envelope's RMS
    }
    float v = 32768.0f * (powf(10, t->level / 20) * x + powf(10, -65.0f / 20) * noise(&t->seed));
    out[i] = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
  }
}

/** Runs `secs` of a talker at `level` through a fresh AGC; returns the output level of the
 * talking parts in the last 4 s, and the loudest output sample. */
static float run(float level, float secs, int *peak) {
  agc_t a;
  agc_init(&a, RATE);
  talker_t t = {.level = level, .seed = 7};
  int16_t f[FRAME];
  double sum = 0;
  long count = 0;
  *peak = 0;
  uint32_t frames = (uint32_t)(secs * RATE / FRAME);
  for (uint32_t k = 0; k < frames; k++) {
    uint32_t start = t.n;
    talk(&t, f, FRAME);
    agc_process(&a, f, FRAME);
    for (int i = 0; i < FRAME; i++) {
      if (abs(f[i]) > *peak) *peak = abs(f[i]);
      if (k * FRAME >= (uint32_t)((secs - 4) * RATE) && talking_at(start + (uint32_t)i)) {
        sum += (double)f[i] * f[i];
        count++;
      }
    }
  }
  return count ? (float)(20 * log10(sqrt(sum / (double)count) / 32768.0)) : -100.0f;
}

TEST(agc_brings_speech_to_target) {
  // Inside the gain range (-6…+18 dB), speech settles at -24 dBFS ± 3 dB.
  for (float level = -42; level <= -18; level += 6) {
    int peak;
    float out = run(level, 12, &peak);
    CHECK_NEAR(out, AGC_TARGET_DBFS, 3);
    if (fabsf(out - AGC_TARGET_DBFS) > 3) fprintf(stderr, "    at %.0f dBFS in: %.1f out\n", level, out);
  }
}

TEST(agc_gain_is_bounded) {
  // Too quiet for +18 dB: as loud as the range allows; too loud: -6 dB.
  int peak;
  CHECK_NEAR(run(-50, 12, &peak), -50 + AGC_MAX_GAIN_DB, 3);
  CHECK_NEAR(run(-12, 12, &peak), -12 + AGC_MIN_GAIN_DB, 3);
}

TEST(agc_never_clips) {
  // A very loud talker (peaks near full scale): nothing above the limiter's -3 dBFS.
  const int limit = (int)(32768 * powf(10, AGC_LIMIT_DBFS / 20)) + 1;
  for (float level = -10; level <= -4; level += 3) {
    int peak;
    run(level, 6, &peak);
    CHECK(peak <= limit);
  }
  // And a sudden burst after a quiet stretch (the gain is high when it comes).
  agc_t a;
  agc_init(&a, RATE);
  talker_t quiet = {.level = -45, .seed = 3}, loud = {.level = -6, .seed = 4};
  int16_t f[FRAME];
  int peak = 0;
  for (int k = 0; k < 400; k++) {
    if (k < 300) {
      talk(&quiet, f, FRAME);
    } else {
      loud.n = quiet.n;  // the same timeline: the burst starts mid-sentence
      talk(&loud, f, FRAME);
      quiet.n = loud.n;
    }
    agc_process(&a, f, FRAME);
    for (int i = 0; i < FRAME; i++)
      if (k >= 300 && abs(f[i]) > peak) peak = abs(f[i]);
  }
  CHECK(peak <= limit);
}

TEST(agc_leaves_silence_alone) {
  // Only noise (no speech): the gain never rises.
  agc_t a;
  agc_init(&a, RATE);
  uint32_t seed = 11;
  int16_t f[FRAME];
  for (int k = 0; k < 500; k++) {
    for (int i = 0; i < FRAME; i++) f[i] = (int16_t)(32768 * powf(10, -60.0f / 20) * noise(&seed));
    agc_process(&a, f, FRAME);
    CHECK(a.gain_db <= 0.01f);
  }
  CHECK(!a.speech);
  // A quiet talker raises the gain; in the pauses after it the gain holds (no pumping of hiss).
  agc_init(&a, RATE);
  talker_t t = {.level = -40, .seed = 5};
  float gain_at_pause = 0;
  bool in_pause = false;
  for (int k = 0; k < 600; k++) {
    uint32_t start = t.n;
    talk(&t, f, FRAME);
    agc_process(&a, f, FRAME);
    bool pause = !talking_at(start) && !talking_at(start + FRAME - 1);
    if (pause && !in_pause) gain_at_pause = a.gain_db;
    if (pause && k > 100) CHECK(a.gain_db <= gain_at_pause + 0.01f);
    in_pause = pause;
  }
  CHECK(a.gain_db > 12);  // it did come up for the talker
}

TEST(agc_attack_fast_release_slow) {
  // Loud speech after quiet: the gain comes down within ~0.2 s (50 ms attack). Quiet speech after
  // loud: it comes up over seconds (2 s release), not at once.
  agc_t a;
  agc_init(&a, RATE);
  talker_t t = {.level = -42, .seed = 9};
  int16_t f[FRAME];
  for (int k = 0; k < 150; k++) {  // 3 s at -42: gain near +18
    talk(&t, f, FRAME);
    agc_process(&a, f, FRAME);
  }
  t.n = 0;  // a talking stretch starts
  float before = a.gain_db;
  t.level = -18;
  for (int k = 0; k < 10; k++) {  // 0.2 s at -18
    talk(&t, f, FRAME);
    agc_process(&a, f, FRAME);
  }
  CHECK(before > 15);
  CHECK(a.gain_db < before - 15);
  for (int k = 0; k < 100; k++) {
    talk(&t, f, FRAME);
    agc_process(&a, f, FRAME);
  }
  before = a.gain_db;
  t.n = 0;
  t.level = -42;
  for (int k = 0; k < 10; k++) {  // 0.2 s quieter: only a little more gain yet
    talk(&t, f, FRAME);
    agc_process(&a, f, FRAME);
  }
  CHECK(a.gain_db < before + 6);
  for (int k = 0; k < 300; k++) {  // 6 s later it has come up
    talk(&t, f, FRAME);
    agc_process(&a, f, FRAME);
  }
  CHECK(a.gain_db > before + 15);
}

TEST(agc_verdict_words) {
  CHECK_STR(agc_verdict(-30, -12), "OK");
  CHECK_STR(agc_verdict(-44, -25), "OK");    // the AGC lifts it (within 3 dB of its range)
  CHECK_STR(agc_verdict(-52, -35), "WEAK");  // more than +18 dB short of the target
  CHECK_STR(agc_verdict(-20, -0.5f), "TOO LOUD");  // the ADC clips
}
