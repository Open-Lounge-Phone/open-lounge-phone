#include "dsp.h"

#include <math.h>

// ITU-T G.711 mu-law with the usual bias of 0x84 (132) and clip at 32635.
uint8_t dsp_ulaw_encode(int16_t pcm) {
  int sign = (pcm >> 8) & 0x80;
  int v = pcm;
  if (sign) v = -v;
  if (v > 32635) v = 32635;
  v += 0x84;
  int exponent = 7;
  for (int mask = 0x4000; (v & mask) == 0 && exponent > 0; mask >>= 1) exponent--;
  int mantissa = (v >> (exponent + 3)) & 0x0F;
  return (uint8_t)~(sign | (exponent << 4) | mantissa);
}

int16_t dsp_ulaw_decode(uint8_t ulaw) {
  ulaw = (uint8_t)~ulaw;
  int sign = ulaw & 0x80;
  int exponent = (ulaw >> 4) & 0x07;
  int mantissa = ulaw & 0x0F;
  int v = ((mantissa << 3) + 0x84) << exponent;
  v -= 0x84;
  return (int16_t)(sign ? -v : v);
}

void dsp_ulaw_encode_buf(const int16_t *pcm, uint8_t *out, size_t n) {
  for (size_t i = 0; i < n; i++) out[i] = dsp_ulaw_encode(pcm[i]);
}

void dsp_ulaw_decode_buf(const uint8_t *in, int16_t *pcm, size_t n) {
  for (size_t i = 0; i < n; i++) pcm[i] = dsp_ulaw_decode(in[i]);
}

// --- tones ----------------------------------------------------------------------------------

static const int16_t *sine_table(void) {
  static int16_t table[256];
  static bool ready;
  if (!ready) {
    for (int i = 0; i < 256; i++) table[i] = (int16_t)lrintf(32767.0f * sinf(6.2831853f * i / 256));
    ready = true;
  }
  return table;
}

static uint32_t step_for(float hz) { return (uint32_t)(hz / DSP_RATE * 4294967296.0); }

void tone_start(tone_gen_t *g, tone_t tone, int16_t amp) {
  *g = (tone_gen_t){.tone = tone, .amp = amp};
  float f[2] = {0, 0};
  float on = 1, off = 0;  // seconds
  switch (tone) {
    case TONE_DIAL: f[0] = 350; f[1] = 440; break;
    case TONE_RINGBACK: f[0] = 440; f[1] = 480; on = 2; off = 4; break;
    case TONE_BUSY: f[0] = 480; f[1] = 620; on = 0.5f; off = 0.5f; break;
    case TONE_HOLD: f[0] = 440; on = 0.25f; off = 3.75f; break;
    case TONE_TEST: f[0] = 1000; break;
    case TONE_NONE: return;
  }
  g->nfreq = f[1] > 0 ? 2 : 1;
  for (int i = 0; i < g->nfreq; i++) g->step[i] = step_for(f[i]);
  g->on = (uint32_t)(on * DSP_RATE);
  g->period = (uint32_t)((on + off) * DSP_RATE);
}

static int16_t sat(int32_t v) { return v > 32767 ? 32767 : v < -32768 ? -32768 : (int16_t)v; }

bool tone_mix(tone_gen_t *g, int16_t *pcm, size_t n) {
  if (g->tone == TONE_NONE) return false;
  const int16_t *t = sine_table();
  bool any = false;
  for (size_t i = 0; i < n; i++) {
    bool on = g->pos % g->period < g->on;
    g->pos++;
    int32_t s = 0;
    for (int k = 0; k < g->nfreq; k++) {
      if (on) s += (int32_t)t[g->phase[k] >> 24] * g->amp / 32767;
      g->phase[k] += g->step[k];
    }
    if (on) {
      pcm[i] = sat(pcm[i] + s);
      any = true;
    }
  }
  return any;
}

const char *tone_name(tone_t t) {
  static const char *names[] = {"none", "dialtone", "ringback", "busy", "hold", "test"};
  return names[t];
}

// --- levels ---------------------------------------------------------------------------------

float dsp_rms_dbfs(const int16_t *pcm, size_t n) {
  if (n == 0) return -100;
  double sum = 0;
  for (size_t i = 0; i < n; i++) sum += (double)pcm[i] * pcm[i];
  double rms = sqrt(sum / n) / 32768.0;
  return rms <= 1e-5 ? -100 : (float)(20 * log10(rms));
}

float dsp_goertzel_dbfs(const int16_t *pcm, size_t n, float freq, float rate) {
  if (n == 0) return -100;
  double w = 2 * 3.14159265358979 * freq / rate, c = 2 * cos(w);
  double s1 = 0, s2 = 0;
  for (size_t i = 0; i < n; i++) {
    double s0 = pcm[i] / 32768.0 + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  double power = s1 * s1 + s2 * s2 - c * s1 * s2;  // |X(k)|^2
  // A sine of amplitude A gives |X| = A*n/2, i.e. an RMS of A/sqrt(2) = |X|*sqrt(2)/n.
  double rms = sqrt(power) * 1.41421356 / n;
  return rms <= 1e-5 ? -100 : (float)(20 * log10(rms));
}

void dsp_meter_init(dsp_meter_t *m, float hz, uint32_t len) {
  *m = (dsp_meter_t){.len = len, .hz = hz, .rms_dbfs = -100, .tone_dbfs = -100};
  m->coeff = 2 * cos(2 * 3.14159265358979 * hz / DSP_RATE);
}

static float to_dbfs(double rms) { return rms <= 1e-5 ? -100 : (float)(20 * log10(rms)); }

bool dsp_meter_feed(dsp_meter_t *m, const int16_t *pcm, size_t n) {
  bool done = false;
  for (size_t i = 0; i < n; i++) {
    double x = pcm[i] / 32768.0;
    m->sumsq += x * x;
    double s0 = x + m->coeff * m->s1 - m->s2;
    m->s2 = m->s1;
    m->s1 = s0;
    if (++m->n == m->len) {
      double power = m->s1 * m->s1 + m->s2 * m->s2 - m->coeff * m->s1 * m->s2;
      m->rms_dbfs = to_dbfs(sqrt(m->sumsq / m->len));
      m->tone_dbfs = to_dbfs(sqrt(power) * 1.41421356 / m->len);
      m->sumsq = m->s1 = m->s2 = 0;
      m->n = 0;
      done = true;
    }
  }
  return done;
}

void dsp_gain(int16_t *pcm, size_t n, float db) {
  if (db == 0) return;
  int32_t g = (int32_t)(powf(10, db / 20) * 4096);  // Q12
  for (size_t i = 0; i < n; i++) pcm[i] = sat(((int32_t)pcm[i] * g) >> 12);
}
