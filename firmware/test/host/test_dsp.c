#include <stdlib.h>
#include "check.h"
#include "dsp.h"

TEST(ulaw_round_trip_is_close) {
  // mu-law keeps ~13 bits of dynamic range: the error grows with the magnitude (<= 1/16).
  for (int v = -32768; v <= 32767; v += 7) {
    int16_t back = dsp_ulaw_decode(dsp_ulaw_encode((int16_t)v));
    int err = abs(back - (v > 32635 ? 32635 : v < -32635 ? -32635 : v));
    CHECK(err <= 8 || err <= abs(v) / 16);
  }
}

TEST(ulaw_known_values) {
  // G.711 reference points: silence is 0xFF, the extremes are 0x80 (+) and 0x00 (-).
  CHECK(dsp_ulaw_encode(0) == 0xFF);
  CHECK(dsp_ulaw_encode(32767) == 0x80);
  CHECK(dsp_ulaw_encode(-32768) == 0x00);
  CHECK(dsp_ulaw_decode(0xFF) == 0);
  CHECK(dsp_ulaw_decode(0x80) == 32124);
  CHECK(dsp_ulaw_decode(0x00) == -32124);
}

TEST(rms_of_full_scale_sine_is_minus_3) {
  int16_t buf[8000] = {0};
  tone_gen_t g;
  tone_start(&g, TONE_TEST, 32767);
  tone_mix(&g, buf, 8000);
  CHECK_NEAR(dsp_rms_dbfs(buf, 8000), -3.0, 0.1);
  CHECK_NEAR(dsp_goertzel_dbfs(buf, 8000, 1000, DSP_RATE), -3.0, 0.2);
  // Far from 1 kHz there is (almost) nothing.
  CHECK(dsp_goertzel_dbfs(buf, 8000, 440, DSP_RATE) < -60);
}

TEST(silence_is_minus_100) {
  int16_t buf[160] = {0};
  CHECK(dsp_rms_dbfs(buf, 160) == -100);
  CHECK(dsp_goertzel_dbfs(buf, 160, 1000, DSP_RATE) == -100);
}

TEST(dial_tone_has_both_frequencies) {
  static int16_t buf[8000];
  memset(buf, 0, sizeof buf);
  tone_gen_t g;
  tone_start(&g, TONE_DIAL, 8000);
  CHECK(tone_mix(&g, buf, 8000));
  float f350 = dsp_goertzel_dbfs(buf, 8000, 350, DSP_RATE);
  float f440 = dsp_goertzel_dbfs(buf, 8000, 440, DSP_RATE);
  float f1000 = dsp_goertzel_dbfs(buf, 8000, 1000, DSP_RATE);
  CHECK_NEAR(f350, f440, 0.5);
  CHECK(f350 > -20 && f350 < -10);  // 8000/32768 peak → -15.3 dBFS RMS
  CHECK(f1000 < f350 - 40);
}

TEST(busy_cadence_half_second) {
  // 480+620 Hz, 0.5 s on / 0.5 s off: the first 4000 samples sound, the next 4000 are silent.
  static int16_t buf[8000];
  memset(buf, 0, sizeof buf);
  tone_gen_t g;
  tone_start(&g, TONE_BUSY, 8000);
  tone_mix(&g, buf, 8000);
  CHECK(dsp_rms_dbfs(buf, 4000) > -20);
  CHECK(dsp_rms_dbfs(buf + 4000, 4000) == -100);
  // It carries on across calls (frame by frame, as the audio task mixes it).
  int16_t frame[160] = {0};
  tone_mix(&g, frame, 160);
  CHECK(dsp_rms_dbfs(frame, 160) > -20);
}

TEST(ringback_two_on_four_off) {
  tone_gen_t g;
  tone_start(&g, TONE_RINGBACK, 8000);
  int16_t frame[160];
  int sounding = 0;
  for (int i = 0; i < 300; i++) {  // 6 s in 20 ms frames
    memset(frame, 0, sizeof frame);
    if (tone_mix(&g, frame, 160)) sounding++;
  }
  CHECK(sounding == 100);  // 2 s of 6
}

TEST(tone_none_leaves_audio_alone) {
  int16_t frame[160];
  for (int i = 0; i < 160; i++) frame[i] = (int16_t)i;
  tone_gen_t g;
  tone_start(&g, TONE_NONE, 8000);
  CHECK(!tone_mix(&g, frame, 160));
  CHECK(frame[100] == 100);
}

TEST(gain_attenuates_and_saturates) {
  int16_t a[2] = {16384, -16384};
  dsp_gain(a, 2, -6.0206f);
  CHECK_NEAR(a[0], 8192, 4);
  CHECK_NEAR(a[1], -8192, 4);
  int16_t b[2] = {30000, -30000};
  dsp_gain(b, 2, 6);
  CHECK(b[0] == 32767 && b[1] == -32768);
}

TEST(meter_matches_block_functions) {
  static int16_t buf[8000];
  memset(buf, 0, sizeof buf);
  tone_gen_t g;
  tone_start(&g, TONE_DIAL, 8000);
  tone_mix(&g, buf, 8000);
  dsp_meter_t m;
  dsp_meter_init(&m, 440, 8000);
  CHECK(m.rms_dbfs == -100);
  bool done = false;
  for (int i = 0; i < 8000; i += 160) done = dsp_meter_feed(&m, buf + i, 160) || done;
  CHECK(done);
  CHECK_NEAR(m.rms_dbfs, dsp_rms_dbfs(buf, 8000), 0.01);
  CHECK_NEAR(m.tone_dbfs, dsp_goertzel_dbfs(buf, 8000, 440, DSP_RATE), 0.01);
  // The next window starts clean: silence reads -100.
  int16_t z[160] = {0};
  for (int i = 0; i < 50; i++) dsp_meter_feed(&m, z, 160);
  CHECK(m.rms_dbfs == -100 && m.tone_dbfs == -100);
}
