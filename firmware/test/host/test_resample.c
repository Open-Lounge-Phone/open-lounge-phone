#include "check.h"
#include "resample.h"

// Level (dBFS) of a sine at `hz` (16 kHz) after going down to 8 kHz, measured at `hz` (or its
// alias) on the output.
static float sine16(int16_t *x, size_t n, float hz, float amp) {
  for (size_t i = 0; i < n; i++) x[i] = (int16_t)(amp * sinf(6.2831853f * hz * (float)i / 16000));
  return 0;
}

static float level(const int16_t *x, size_t n) {
  double s = 0;
  for (size_t i = 0; i < n; i++) s += (double)x[i] * x[i];
  double r = sqrt(s / (double)n) / 32768;
  return r < 1e-7 ? -140.0f : (float)(20 * log10(r));
}

TEST(rs_down_passes_the_telephone_band_and_stops_the_rest) {
  static int16_t in[16000], out[8000];
  for (float hz = 100; hz <= 7900; hz += 100) {
    sine16(in, 16000, hz, 16384);
    rs_t r;
    rs_init(&r);
    size_t m = rs_down(&r, in, 16000, out);
    CHECK(m == 8000);
    float gain = level(out + 200, 7800) - level(in, 16000);
    if (hz <= 3400) CHECK_NEAR(gain, 0, 0.1);   // flat
    if (hz >= 4600) CHECK(gain < -60);          // nothing folds back into the band
    if ((hz <= 3400 && fabsf(gain) > 0.1f) || (hz >= 4600 && gain >= -60))
      fprintf(stderr, "    down %.0f Hz: %.2f dB\n", hz, gain);
  }
}

TEST(rs_up_passes_the_band_without_images) {
  static int16_t in[8000], out[16000];
  for (float hz = 100; hz <= 3400; hz += 100) {
    for (size_t i = 0; i < 8000; i++) in[i] = (int16_t)(16384 * sinf(6.2831853f * hz * (float)i / 8000));
    rs_t r;
    rs_init(&r);
    CHECK(rs_up(&r, in, 8000, out) == 16000);
    // The tone keeps its level; its image at 8 kHz - f is gone (at least 60 dB down).
    double re = 0, im = 0, ri = 0, ii = 0;
    for (int i = 400; i < 16000; i++) {
      double t = 6.2831853 * i / 16000;
      re += out[i] * cos(hz * t);
      im += out[i] * sin(hz * t);
      ri += out[i] * cos((8000 - hz) * t);
      ii += out[i] * sin((8000 - hz) * t);
    }
    double tone = sqrt(re * re + im * im), image = sqrt(ri * ri + ii * ii);
    float rel = (float)(20 * log10(image / tone + 1e-12));
    float gain = level(out + 400, 15600) - level(in, 8000);
    CHECK_NEAR(gain, 0, 0.1);
    CHECK(rel < -60);
    if (fabsf(gain) > 0.1f || rel >= -60) fprintf(stderr, "    up %.0f Hz: %.2f dB, image %.1f dB\n", hz, gain, rel);
  }
}

TEST(rs_streams_frame_by_frame) {
  // 20 ms frames give the same samples as one block (the state carries over).
  static int16_t in[3200], whole[1600], parts[1600];
  sine16(in, 3200, 440, 12000);
  rs_t a, b;
  rs_init(&a);
  rs_init(&b);
  rs_down(&a, in, 3200, whole);
  for (int f = 0; f < 10; f++) rs_down(&b, in + f * 320, 320, parts + f * 160);
  CHECK(memcmp(whole, parts, sizeof whole) == 0);
}
