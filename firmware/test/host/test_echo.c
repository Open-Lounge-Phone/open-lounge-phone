#include <stdlib.h>

#include "check.h"
#include "echo.h"

#define RATE 16000
#define FRAME 320
#define SECS 6
#define N (RATE * SECS)

// A handset's echo path: a direct leak 3 ms after the earpiece, then a few weaker reflections
// over 20 ms; about 20 dB of loss overall (a poor handset: the canceller's real work).
static void echo_path(const int16_t *ref, int16_t *echo, size_t n, float gain) {
  static const struct { int lag; float g; } taps[] = {
      {48, 0.08f}, {52, -0.05f}, {70, 0.03f}, {130, -0.02f}, {250, 0.012f}, {330, -0.006f}};
  for (size_t i = 0; i < n; i++) {
    float y = 0;
    for (size_t k = 0; k < sizeof taps / sizeof taps[0]; k++)
      if (i >= (size_t)taps[k].lag) y += taps[k].g * (float)ref[i - (size_t)taps[k].lag];
    echo[i] = (int16_t)(y * gain);
  }
}

static uint32_t seed = 3;
static float rnd(void) {
  seed = seed * 1664525u + 1013904223u;
  return (float)(seed >> 8) / 16777216.0f - 0.5f;
}

// Speech-like test audio: a voice (harmonics of a gliding pitch) with breath noise (low-passed),
// under a syllable envelope that sometimes pauses.
static void talker(int16_t *x, size_t n, float f0, float f1, float amp, float rate_hz) {
  float ph = 0, lp = 0;
  for (size_t i = 0; i < n; i++) {
    float t = (float)i / RATE, f = f0 + (f1 - f0) * (0.5f + 0.5f * sinf(6.2831853f * 0.3f * t));
    ph += 6.2831853f * f / RATE;
    float v = 0;
    for (int k = 1; (float)k * f < 7000; k++) v += sinf(ph * (float)k) / (float)k;
    lp += 0.3f * (rnd() * 6 - lp);
    float env = sinf(6.2831853f * rate_hz * t);
    env = env > 0 ? env : 0.1f * -env;
    x[i] = (int16_t)((0.7f * v + 0.6f * lp) * env * amp);
  }
}

static int16_t hiss(float dbfs) { return (int16_t)(rnd() * 3.46f * 32768 * powf(10, dbfs / 20)); }

static double energy(const int16_t *x, size_t a, size_t b) {
  double s = 0;
  for (size_t i = a; i < b; i++) s += (double)x[i] * x[i];
  return s;
}

TEST(echo_canceller_removes_20_db_and_keeps_double_talk) {
  static int16_t far[N], echo[N], near[N], mic[N], out[N];
  talker(far, N, 140, 220, 5000, 3.1f);
  echo_path(far, echo, N, 1.0f);
  // The near end talks from 4 s to 5 s (double talk), otherwise only the room's hiss.
  memset(near, 0, sizeof near);
  talker(near + 4 * RATE, RATE, 230, 300, 2500, 4.3f);
  for (size_t i = 0; i < N; i++) mic[i] = (int16_t)(echo[i] + near[i] + hiss(-70));
  echo_t e;
  CHECK(echo_open(&e, RATE, FRAME, true));
  memcpy(out, mic, sizeof mic);
  for (size_t f = 0; f + FRAME <= N; f += FRAME) echo_process(&e, out + f, far + f);
  // Converged within a second: from 1 s to 4 s at least 20 dB of the echo is gone.
  double before = energy(mic, RATE, 4 * RATE), after = energy(out, RATE, 4 * RATE);
  float erle = (float)(10 * log10(before / (after + 1)));
  CHECK(erle >= 20);
  CHECK(e.erle_db > 10);  // its own report (the last second: echo only)
  // Double talk: the near end's voice comes through (no more than 6 dB lost)...
  double ne = energy(near, 4 * RATE + RATE / 5, 5 * RATE), oe = energy(out, 4 * RATE + RATE / 5, 5 * RATE);
  float kept = (float)(10 * log10(oe / ne));
  CHECK(kept > -6);
  // ...and the canceller hasn't lost its way: the echo is gone again right after.
  float again = (float)(10 * log10(energy(mic, 5 * RATE + RATE / 5, 6 * RATE) /
                                   (energy(out, 5 * RATE + RATE / 5, 6 * RATE) + 1)));
  CHECK(again >= 15);
  if (erle < 20 || kept <= -6 || again < 15)
    fprintf(stderr, "    ERLE %.1f dB (reported %.1f), near end kept %.1f dB, after %.1f dB\n", erle,
            e.erle_db, kept, again);
  echo_close(&e);
}

TEST(echo_meter_reports_the_erl) {
  static int16_t far[N], mic[N];
  talker(far, N, 140, 220, 5000, 3.1f);
  echo_path(far, mic, N, 1.0f);
  for (size_t i = 0; i < N; i++) mic[i] = (int16_t)(mic[i] + hiss(-75));
  echo_t e;
  CHECK(echo_open(&e, RATE, FRAME, false));  // measuring only: the mic is left alone
  int16_t keep[FRAME];
  memcpy(keep, mic, sizeof keep);
  echo_process(&e, mic, far);
  CHECK(memcmp(keep, mic, sizeof keep) == 0);
  for (size_t f = FRAME; f + FRAME <= N; f += FRAME) echo_process(&e, mic + f, far + f);
  // The path's loss: 10log(far/echo power) for this signal (about 19 dB).
  float truth = (float)(10 * log10(energy(far, 0, N) / energy(mic, 0, N)));
  CHECK_NEAR(e.erl_db, truth, 1.5);
  CHECK(e.erl_best_db >= e.erl_db);
  CHECK(e.erle_db == 0);
}

TEST(echo_test_finds_the_loss_and_delay) {
  size_t n = echo_test_len(RATE);
  int16_t *ref = calloc(n, 2), *mic = calloc(n, 2);
  for (size_t i = 0; i < n; i++) ref[i] = echo_test_sample(i, RATE);
  // 35 dB of loss, 4 ms after the earpiece, over -70 dBFS of hiss.
  float g = powf(10, -35.0f / 20);
  for (size_t i = 0; i < n; i++) mic[i] = (int16_t)((i >= 64 ? g * ref[i - 64] : 0) + hiss(-70));
  echo_result_t r = echo_test_measure(ref, mic, n, RATE);
  CHECK(r.heard);
  CHECK_NEAR(r.erl_db, 35, 2);
  CHECK_NEAR(r.delay_ms, 4, 0.2);
  CHECK_NEAR(r.noise_dbfs, -70, 1.5);
  CHECK_STR(echo_word(r.erl_db), "OK");
  // A good handset: nothing comes back above the noise.
  for (size_t i = 0; i < n; i++) mic[i] = hiss(-70);
  r = echo_test_measure(ref, mic, n, RATE);
  CHECK(!r.heard);
  CHECK(r.erl_db >= 45);
  CHECK_STR(echo_word(r.erl_db), "GOOD");
  CHECK_STR(echo_word(22), "POOR");
  free(ref);
  free(mic);
}
