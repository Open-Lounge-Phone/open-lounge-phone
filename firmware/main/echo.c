#include "echo.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "speex/speex_echo.h"
#include "speex/speex_preprocess.h"

// SpeexDSP's memory and messages (components/speexdsp/src/config.h).
__attribute__((weak)) void *echo_alloc(size_t size) { return calloc(1, size); }
__attribute__((weak)) void echo_free(void *p) { free(p); }
static uint32_t s_warnings;
uint32_t echo_warnings(void) { return s_warnings; }
void *speex_alloc(int size) { return echo_alloc((size_t)size); }
void *speex_alloc_scratch(int size) { return echo_alloc((size_t)size); }
void *speex_realloc(void *ptr, int size) {
  (void)ptr;
  (void)size;
  return NULL;  // not used by the echo canceller or the preprocessor
}
void speex_free(void *ptr) { echo_free(ptr); }
void speex_free_scratch(void *ptr) { echo_free(ptr); }
// e.g. "The echo canceller started acting funny and got slapped (reset)": it restarted itself.
void speex_warning(const char *str) {
  (void)str;
  s_warnings++;
}
void speex_warning_int(const char *str, int val) {
  (void)str;
  (void)val;
  s_warnings++;
}
void speex_notify(const char *str) { (void)str; }

static double energy(const int16_t *x, size_t n) {
  double s = 0;
  for (size_t i = 0; i < n; i++) s += (double)x[i] * x[i];
  return s;
}

static float db(double ratio) { return ratio <= 1e-12 ? -120.0f : (float)(10 * log10(ratio)); }

bool echo_open(echo_t *e, int rate, int frame, bool cancel) {
  memset(e, 0, sizeof *e);
  e->rate = rate;
  e->frame = frame;
  e->erl_db = e->erl_best_db = -1;
  if (!cancel) return true;
  // Speex works in 10 ms blocks (two per 20 ms frame): it adapts faster than with 20 ms ones.
  int block = rate / 100;
  SpeexEchoState *aec = speex_echo_state_init(block, rate * ECHO_TAIL_MS / 1000);
  SpeexPreprocessState *pp = aec ? speex_preprocess_state_init(block, rate) : NULL;
  if (!aec || !pp) {
    if (aec) speex_echo_state_destroy(aec);
    return false;
  }
  speex_echo_ctl(aec, SPEEX_ECHO_SET_SAMPLING_RATE, &rate);
  // The residual echo suppressor works through the preprocessor's spectral gain, which only
  // applies with its noise suppression on: that is set to a mild 6 dB. No gain control here
  // (the AGC follows) and no dereverb.
  int on = 1, off = 0, noise_db = -6;
  speex_preprocess_ctl(pp, SPEEX_PREPROCESS_SET_DENOISE, &on);
  speex_preprocess_ctl(pp, SPEEX_PREPROCESS_SET_NOISE_SUPPRESS, &noise_db);
  speex_preprocess_ctl(pp, SPEEX_PREPROCESS_SET_AGC, &off);
  speex_preprocess_ctl(pp, SPEEX_PREPROCESS_SET_DEREVERB, &off);
  speex_preprocess_ctl(pp, SPEEX_PREPROCESS_SET_ECHO_STATE, aec);
  e->aec = aec;
  e->pp = pp;
  return true;
}

void echo_close(echo_t *e) {
  if (e->pp) speex_preprocess_state_destroy(e->pp);
  if (e->aec) speex_echo_state_destroy(e->aec);
  e->pp = e->aec = NULL;
}

void echo_process(echo_t *e, int16_t *mic, const int16_t *ref) {
  size_t n = (size_t)e->frame;
  double re = energy(ref, n), me = energy(mic, n);
  bool active = db(re / (double)n / (32768.0 * 32768.0)) > ECHO_ACTIVE_DBFS;
  if (e->aec) {
    int16_t out[480];
    size_t block = (size_t)e->rate / 100;
    for (size_t at = 0; at + block <= n; at += block) {
      speex_echo_cancellation(e->aec, mic + at, ref + at, out);
      speex_preprocess_run(e->pp, out);
      memcpy(mic + at, out, block * sizeof *mic);
    }
  }
  if (active) {
    e->ref_e += re;
    e->mic_e += me;
    e->out_e += energy(mic, n);
    e->active++;
  }
  if (++e->frames * n < (size_t)e->rate) return;  // a one-second window
  if (e->active >= 10 && e->mic_e > 0) {
    e->erl_db = db(e->ref_e / e->mic_e);
    if (e->erl_db > e->erl_best_db) e->erl_best_db = e->erl_db;
    e->erle_db = e->aec ? db(e->mic_e / (e->out_e + 1)) : 0;
  }
  e->ref_e = e->mic_e = e->out_e = 0;
  e->active = e->frames = 0;
}

// --- the echo test --------------------------------------------------------------------------

size_t echo_test_len(int rate) {
  return (size_t)rate * (ECHO_TEST_QUIET_MS + ECHO_TEST_SWEEP_MS + ECHO_TEST_TAIL_MS) / 1000;
}

int16_t echo_test_sample(size_t i, int rate) {
  size_t q = (size_t)rate * ECHO_TEST_QUIET_MS / 1000, s = (size_t)rate * ECHO_TEST_SWEEP_MS / 1000;
  if (i < q || i >= q + s) return 0;
  // A logarithmic sweep 200 Hz → 7 kHz at -20 dBFS (RMS), faded in and out over 10 ms.
  double t = (double)(i - q) / rate, T = (double)s / rate, f0 = 200, f1 = 7000;
  double k = log(f1 / f0);
  double phase = 2 * M_PI * f0 * T / k * (exp(t / T * k) - 1);
  double fade = fmin(1.0, fmin(t, T - t) / 0.01);
  return (int16_t)lrint(32768 * 0.1414 * fade * sin(phase));
}

echo_result_t echo_test_measure(const int16_t *ref, const int16_t *mic, size_t n, int rate) {
  echo_result_t r = {0};
  size_t q = (size_t)rate * ECHO_TEST_QUIET_MS / 1000, s = (size_t)rate * ECHO_TEST_SWEEP_MS / 1000;
  if (n < q + s) return r;
  // The noise: the quiet part (after the first 50 ms).
  size_t skip = (size_t)rate / 20;
  double noise = energy(mic + skip, q - skip) / (double)(q - skip);
  r.noise_dbfs = db(noise / (32768.0 * 32768.0));
  // The delay: where the mic best matches the sweep, 0-50 ms later.
  size_t max_lag = (size_t)rate / 20;
  double best = 0;
  size_t lag = 0;
  for (size_t d = 0; d <= max_lag && q + s + d <= n; d++) {
    double c = 0;
    for (size_t i = q; i < q + s; i += 2) c += (double)ref[i] * mic[i + d];
    if (fabs(c) > best) {
      best = fabs(c);
      lag = d;
    }
  }
  double pr = energy(ref + q, s) / (double)s;
  double pm = energy(mic + q + lag, s) / (double)s;
  // The echo's own power: what came back above the noise, and the part that matches the sweep.
  double corr = best * 2 / (double)s;  // ≈ gain x pr for an echo of gain g
  double gain = corr / pr;
  double echo = gain * gain * pr;
  r.heard = echo > noise * 0.5 && pm > noise * 1.2;
  if (r.heard) {
    r.erl_db = db(pr / echo);
    r.delay_ms = 1000.0f * (float)lag / (float)rate;
  } else {
    r.erl_db = db(pr / (noise + 1));  // at least this much
  }
  return r;
}

const char *echo_word(float erl_db) {
  return erl_db >= ECHO_GOOD_DB ? "GOOD" : erl_db >= ECHO_POOR_DB ? "OK" : "POOR";
}
