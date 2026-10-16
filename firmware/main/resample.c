#include "resample.h"

#include <math.h>
#include <stdbool.h>
#include <string.h>

static float s_h[RS_TAPS];

/** I0 (modified Bessel, first kind) for the Kaiser window, by its series. */
static double bessel_i0(double x) {
  double sum = 1, term = 1;
  for (int k = 1; k < 40; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
  }
  return sum;
}

static void design(void) {
  static bool ready;
  if (ready) return;
  const double beta = 7.0, mid = (RS_TAPS - 1) / 2.0;
  for (int i = 0; i < RS_TAPS; i++) {
    double n = i - mid;
    double sinc = n == 0 ? 1.0 : sin(M_PI * n / 2) / (M_PI * n / 2);
    double r = n / mid;
    double w = bessel_i0(beta * sqrt(1 - r * r)) / bessel_i0(beta);
    s_h[i] = (float)(0.5 * sinc * w);  // half-band: cut-off at a quarter of 16 kHz
  }
  ready = true;
}

void rs_init(rs_t *r) {
  design();
  memset(r, 0, sizeof *r);
}

static void push(rs_t *r, float x) {
  r->at = (r->at + 1) % RS_TAPS;
  r->hist[r->at] = x;
}

static float fir(const rs_t *r) {
  float y = 0;
  int k = r->at;
  for (int i = 0; i < RS_TAPS; i++) {
    y += s_h[i] * r->hist[k];
    k = k ? k - 1 : RS_TAPS - 1;
  }
  return y;
}

static int16_t sat(float v) {
  long x = lrintf(v);
  return (int16_t)(x > 32767 ? 32767 : x < -32768 ? -32768 : x);
}

size_t rs_down(rs_t *r, const int16_t *in, size_t n, int16_t *out) {
  size_t m = 0;
  for (size_t i = 0; i < n; i++) {
    push(r, in[i]);
    if (r->phase ^= 1) continue;  // every second sample
    out[m++] = sat(fir(r));
  }
  return m;
}

size_t rs_up(rs_t *r, const int16_t *in, size_t n, int16_t *out) {
  for (size_t i = 0; i < n; i++) {
    push(r, in[i]);
    out[2 * i] = sat(2 * fir(r));  // zero-stuffed: x2 keeps the level
    push(r, 0);
    out[2 * i + 1] = sat(2 * fir(r));
  }
  return 2 * n;
}
