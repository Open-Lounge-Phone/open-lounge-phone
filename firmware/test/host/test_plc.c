#include <stdlib.h>

#include "check.h"
#include "plc.h"

// A voice-like test signal: harmonics of a pitch that glides (so a repeated period drifts away
// from the real signal, as with speech), amplitude about -16 dBFS.
static void voice(int rate, float f0, float f1, float *phase, int16_t *out, size_t n, size_t at,
                  size_t total) {
  for (size_t i = 0; i < n; i++) {
    float f = f0 + (f1 - f0) * (float)(at + i) / (float)total;
    *phase += 6.2831853f * f / (float)rate;
    float x = sinf(*phase) + 0.5f * sinf(2 * *phase) + 0.25f * sinf(3 * *phase);
    out[i] = (int16_t)(x * 4000);
  }
}

static int max_step(const int16_t *x, size_t n) {
  int m = 0;
  for (size_t i = 1; i < n; i++)
    if (abs(x[i] - x[i - 1]) > m) m = abs(x[i] - x[i - 1]);
  return m;
}

static float rms_db(const int16_t *x, size_t n) {
  double s = 0;
  for (size_t i = 0; i < n; i++) s += (double)x[i] * x[i];
  double r = sqrt(s / (double)n) / 32768;
  return r < 1e-6 ? -120.0f : (float)(20 * log10(r));
}

/** Every `every`th frame lost: the output has no step larger than `limit` x the clean signal's. */
static void drops_are_smooth(int rate, float f0, float f1, int every) {
  enum { SECS = 2 };
  size_t frame = (size_t)rate / 50, total = (size_t)rate * SECS;
  static int16_t clean[16000 * SECS], out[16000 * SECS];
  float ph = 0;
  voice(rate, f0, f1, &ph, clean, total, 0, total);
  plc_t p;
  plc_init(&p, rate);
  int lost = 0;
  float first_lost_db = 0, around_db = 0;
  for (size_t k = 0; k * frame < total; k++) {
    if (k > 3 && k % (size_t)every == 0) {
      plc_lost(&p, out + k * frame, frame);
      if (!lost) {
        // The first lost frame's made-up part (after the delay) sounds like the voice.
        first_lost_db = rms_db(out + k * frame + p.delay, frame - (size_t)p.delay);
        around_db = rms_db(clean + (k - 1) * frame, frame);
      }
      lost++;
    } else {
      plc_good(&p, clean + k * frame, out + k * frame, frame);
    }
  }
  int clean_step = max_step(clean, total), got = max_step(out + frame, total - frame);
  CHECK(lost > 10);
  CHECK(got <= clean_step * 3 / 2);
  if (got > clean_step * 3 / 2)
    fprintf(stderr, "    %d Hz %.0f->%.0f Hz every %d: step %d vs clean %d\n", rate, f0, f1, every,
            got, clean_step);
  CHECK_NEAR(first_lost_db, around_db, 3);
  CHECK(p.concealed_frames == (uint32_t)lost);
}

TEST(plc_conceals_single_losses_smoothly) {
  drops_are_smooth(16000, 180, 260, 5);
  drops_are_smooth(16000, 250, 250, 7);
  drops_are_smooth(8000, 140, 210, 4);
}

TEST(plc_fades_out_long_losses_then_returns) {
  int rate = 16000;
  size_t frame = 320;
  int16_t in[320], out[320];
  float ph = 0;
  plc_t p;
  plc_init(&p, rate);
  for (int k = 0; k < 10; k++) {
    voice(rate, 200, 200, &ph, in, frame, 0, 1);
    plc_good(&p, in, out, frame);
  }
  float level = rms_db(out, frame), prev = 0;
  // 10 frames lost (200 ms): the first still sounds; the energy only goes down; from 60 ms (plus
  // the 3.75 ms delay) on it's silence.
  for (int k = 0; k < 10; k++) {
    plc_lost(&p, out, frame);
    float db = rms_db(out, frame);
    if (k == 0) CHECK_NEAR(db, level, 2);
    if (k > 0) CHECK(db <= prev + 0.5f);
    if (k >= 4) CHECK(db == -120.0f);
    prev = db;
  }
  // Back: within a frame (and the delay) it's the voice again, faded in without a step.
  voice(rate, 200, 200, &ph, in, frame, 0, 1);
  plc_good(&p, in, out, frame);
  CHECK(max_step(out, frame) <= max_step(in, frame) * 3 / 2);
  voice(rate, 200, 200, &ph, in, frame, 0, 1);
  plc_good(&p, in, out, frame);
  CHECK_NEAR(rms_db(out, frame), level, 1);
}

TEST(plc_delays_by_3_75_ms) {
  plc_t p;
  plc_init(&p, 16000);
  CHECK(p.delay == 60);
  int16_t in[320] = {0}, out[320];
  in[0] = 1000;  // an impulse at the frame's start comes out 60 samples later
  plc_good(&p, in, out, 320);
  CHECK(out[60] == 1000);
  CHECK(out[0] == 0 && out[59] == 0 && out[61] == 0);
}

TEST(plc_repeats_the_right_period) {
  // A steady voice: the made-up first 10 ms of a loss follow what the voice would have done
  // (at least 12 dB signal to error), so the period it found is the voice's.
  static const float pitches[] = {250, 180, 133};
  for (int k = 0; k < 3; k++) {
    int rate = 16000;
    int16_t in[320], out[320], truth[320 + 60];
    float ph = 0;
    plc_t p;
    plc_init(&p, rate);
    for (int f = 0; f < 6; f++) {
      voice(rate, pitches[k], pitches[k], &ph, in, 320, 0, 1);
      plc_good(&p, in, out, 320);
    }
    float keep = ph;
    voice(rate, pitches[k], pitches[k], &ph, truth, 320, 0, 1);
    ph = keep;
    plc_lost(&p, out, 320);
    // out[60 + i] is the made-up continuation of truth[i] (the output runs 60 samples behind).
    double sig = 0, err = 0;
    for (int i = 0; i < 160; i++) {
      double d = (double)out[60 + i] - truth[i];
      sig += (double)truth[i] * truth[i];
      err += d * d;
    }
    float snr = (float)(10 * log10(sig / (err + 1)));
    CHECK(snr >= 12);
    if (snr < 12) fprintf(stderr, "    %.0f Hz: SNR %.1f dB (pitch %d)\n", pitches[k], snr, p.pitch);
  }
}
