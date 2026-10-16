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
  static int16_t buf[DSP_RATE];
  memset(buf, 0, sizeof buf);
  tone_gen_t g;
  tone_start(&g, TONE_TEST, 32767);
  tone_mix(&g, buf, DSP_RATE);
  CHECK_NEAR(dsp_rms_dbfs(buf, DSP_RATE), -3.0, 0.1);
  CHECK_NEAR(dsp_goertzel_dbfs(buf, DSP_RATE, 1000, DSP_RATE), -3.0, 0.2);
  // Far from 1 kHz there is (almost) nothing.
  CHECK(dsp_goertzel_dbfs(buf, DSP_RATE, 440, DSP_RATE) < -60);
}

TEST(silence_is_minus_100) {
  int16_t buf[160] = {0};
  CHECK(dsp_rms_dbfs(buf, 160) == -100);
  CHECK(dsp_goertzel_dbfs(buf, 160, 1000, DSP_RATE) == -100);
}

TEST(dial_tone_has_both_frequencies) {
  static int16_t buf[DSP_RATE];
  memset(buf, 0, sizeof buf);
  tone_gen_t g;
  tone_start(&g, TONE_DIAL, 8000);
  CHECK(tone_mix(&g, buf, DSP_RATE));
  float f350 = dsp_goertzel_dbfs(buf, DSP_RATE, 350, DSP_RATE);
  float f440 = dsp_goertzel_dbfs(buf, DSP_RATE, 440, DSP_RATE);
  float f1000 = dsp_goertzel_dbfs(buf, DSP_RATE, 1000, DSP_RATE);
  CHECK_NEAR(f350, f440, 0.5);
  CHECK(f350 > -20 && f350 < -10);  // 8000/32768 peak → -15.3 dBFS RMS
  CHECK(f1000 < f350 - 40);
}

TEST(busy_cadence_half_second) {
  // 480+620 Hz, 0.5 s on / 0.5 s off: the first 4000 samples sound, the next 4000 are silent.
  static int16_t buf[DSP_RATE];
  memset(buf, 0, sizeof buf);
  tone_gen_t g;
  tone_start(&g, TONE_BUSY, 8000);
  tone_mix(&g, buf, DSP_RATE);
  CHECK(dsp_rms_dbfs(buf, DSP_RATE / 2) > -20);
  CHECK(dsp_rms_dbfs(buf + DSP_RATE / 2, DSP_RATE / 2) == -100);
  // It carries on across calls (frame by frame, as the audio task mixes it).
  int16_t frame[160] = {0};
  tone_mix(&g, frame, 160);
  CHECK(dsp_rms_dbfs(frame, 160) > -20);
}

TEST(ringback_two_on_four_off) {
  tone_gen_t g;
  tone_start(&g, TONE_RINGBACK, 8000);
  int16_t frame[DSP_FRAME];
  int sounding = 0;
  for (int i = 0; i < 300; i++) {  // 6 s in 20 ms frames
    memset(frame, 0, sizeof frame);
    if (tone_mix(&g, frame, DSP_FRAME)) sounding++;
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
  static int16_t buf[DSP_RATE];
  memset(buf, 0, sizeof buf);
  tone_gen_t g;
  tone_start(&g, TONE_DIAL, 8000);
  tone_mix(&g, buf, DSP_RATE);
  dsp_meter_t m;
  dsp_meter_init(&m, 440, DSP_RATE);
  CHECK(m.rms_dbfs == -100);
  bool done = false;
  for (int i = 0; i < DSP_RATE; i += DSP_FRAME) done = dsp_meter_feed(&m, buf + i, DSP_FRAME) || done;
  CHECK(done);
  CHECK_NEAR(m.rms_dbfs, dsp_rms_dbfs(buf, DSP_RATE), 0.01);
  CHECK_NEAR(m.tone_dbfs, dsp_goertzel_dbfs(buf, DSP_RATE, 440, DSP_RATE), 0.01);
  // The next window starts clean: silence reads -100.
  int16_t z[DSP_FRAME] = {0};
  for (int i = 0; i < 50; i++) dsp_meter_feed(&m, z, DSP_FRAME);
  CHECK(m.rms_dbfs == -100 && m.tone_dbfs == -100);
}

TEST(sidetone_mix_levels_and_off) {
  int16_t mic[DSP_FRAME], out[DSP_FRAME];
  tone_gen_t g;
  memset(mic, 0, sizeof mic);
  tone_start(&g, TONE_TEST, 16384);
  tone_mix(&g, mic, DSP_FRAME);
  float in = dsp_rms_dbfs(mic, DSP_FRAME);
  // Normal is 20 dB under the mic, low 26 dB; off (and muted: gain 0) adds nothing.
  static const struct { sidetone_t level; float db; } cases[] = {
      {SIDETONE_NORMAL, -20}, {SIDETONE_LOW, -26}};
  for (int i = 0; i < 2; i++) {
    memset(out, 0, sizeof out);
    dsp_sidetone_mix(out, mic, DSP_FRAME, dsp_gain_q15(dsp_sidetone_db(cases[i].level)));
    CHECK_NEAR(dsp_rms_dbfs(out, DSP_FRAME) - in, cases[i].db, 0.2);
  }
  for (int i = 0; i < DSP_FRAME; i++) out[i] = (int16_t)i;
  dsp_sidetone_mix(out, mic, DSP_FRAME, dsp_gain_q15(dsp_sidetone_db(SIDETONE_OFF)));
  CHECK(out[100] == 100 && out[319] == 319);
  // It mixes (adds to the call's audio) and saturates rather than wrapping.
  for (int i = 0; i < DSP_FRAME; i++) out[i] = 32000;
  dsp_sidetone_mix(out, mic, DSP_FRAME, dsp_gain_q15(0));
  int16_t lo = 32767;
  for (int i = 0; i < DSP_FRAME; i++) lo = out[i] < lo ? out[i] : lo;
  CHECK(lo > 15000);
}
