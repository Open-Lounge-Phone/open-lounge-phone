#include "plc.h"

#include <math.h>
#include <string.h>

static int hist_len(const plc_t *p) { return p->rate * 48 / 1000; }

void plc_init(plc_t *p, int rate) {
  memset(p, 0, sizeof *p);
  if (rate > PLC_MAX_RATE) rate = PLC_MAX_RATE;
  p->rate = rate;
  p->delay = rate * 375 / 100000;  // 3.75 ms
}

/** Appends n samples to the history and reads n samples `delay` behind its end. */
static void push(plc_t *p, const int16_t *in, int16_t *out, size_t n) {
  int H = hist_len(p);
  if ((int)n > H - p->delay) n = (size_t)(H - p->delay);
  memmove(p->hist, p->hist + n, (size_t)(H - (int)n) * sizeof(int16_t));
  memcpy(p->hist + H - n, in, n * sizeof(int16_t));
  memcpy(out, p->hist + H - p->delay - n, n * sizeof(int16_t));
}

/** Made-up samples' gain `t` samples into a loss: full for 10 ms, then down to 0 at 60 ms. */
static float fade(const plc_t *p, int t) {
  int full = p->rate / 100, end = p->rate * 6 / 100;
  if (t < full) return 1.0f;
  if (t >= end) return 0.0f;
  return 1.0f - (float)(t - full) / (float)(end - full);
}

static void synth(plc_t *p, int16_t *out, size_t n, int t0) {
  for (size_t k = 0; k < n; k++) {
    out[k] = (int16_t)lrintf((float)p->period[p->pos] * fade(p, t0 + (int)k));
    p->pos = (p->pos + 1) % p->pitch;
  }
}

/** The pitch period (5-15 ms) that best repeats the last 20 ms. */
static int find_pitch(const plc_t *p) {
  int H = hist_len(p), W = p->rate / 50, lo = p->rate / 200, hi = p->rate * 15 / 1000;
  int best = lo;
  float best_score = 0;
  for (int lag = lo; lag <= hi; lag++) {
    float c = 0, e = 0;
    for (int i = H - W; i < H; i++) {
      c += (float)p->hist[i] * (float)p->hist[i - lag];
      e += (float)p->hist[i - lag] * (float)p->hist[i - lag];
    }
    float score = e > 0 ? c / sqrtf(e) : 0;
    if (score > best_score) {
      best_score = score;
      best = lag;
    }
  }
  return best;
}

void plc_lost(plc_t *p, int16_t *out, size_t n) {
  if (n > PLC_MAX_FRAME) n = PLC_MAX_FRAME;
  int H = hist_len(p);
  if (p->lost == 0) {
    p->pitch = find_pitch(p);
    // Blend the last quarter period into the one before it, so repeating the period carries on
    // smoothly (these samples are still inside the delay: not played yet).
    int L = p->pitch / 4;
    if (L > p->delay) L = p->delay;
    for (int i = 0; i < L; i++) {
      float w = (float)(i + 1) / (float)(L + 1);
      int at = H - L + i;
      p->hist[at] = (int16_t)lrintf((float)p->hist[at] * (1 - w) + (float)p->hist[at - p->pitch] * w);
    }
    memcpy(p->period, p->hist + H - p->pitch, (size_t)p->pitch * sizeof(int16_t));
    p->pos = 0;
  }
  int16_t made[PLC_MAX_FRAME];
  synth(p, made, n, p->lost);
  p->lost += (int)n;
  p->concealed_frames++;
  push(p, made, out, n);
}

void plc_good(plc_t *p, const int16_t *in, int16_t *out, size_t n) {
  if (n > PLC_MAX_FRAME) n = PLC_MAX_FRAME;
  if (p->lost == 0) {
    push(p, in, out, n);
    return;
  }
  // Back from a loss: fade from the made-up signal into the real one over a quarter period + 4 ms.
  int16_t mixed[PLC_MAX_FRAME];
  memcpy(mixed, in, n * sizeof(int16_t));
  int L = p->pitch / 4 + p->rate / 250;
  if (L > (int)n) L = (int)n;
  int16_t tail[PLC_MAX_FRAME];
  synth(p, tail, (size_t)L, p->lost);
  for (int i = 0; i < L; i++) {
    float w = (float)(i + 1) / (float)(L + 1);
    mixed[i] = (int16_t)lrintf((float)tail[i] * (1 - w) + (float)in[i] * w);
  }
  p->lost = 0;
  push(p, mixed, out, n);
}
