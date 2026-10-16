#include <stdlib.h>

#include "check.h"
#include "dsp.h"
#include "voice.h"

#define SECS 1
#define N (VOICE_RATE * SECS)

static void tone(int16_t *x, size_t n, float hz, float amp) {
  for (size_t i = 0; i < n; i++) x[i] = (int16_t)(amp * sinf(6.2831853f * hz * (float)i / VOICE_RATE));
}

// A voice: harmonics to 7 kHz of a pitch gliding 120→300 Hz, with a syllable envelope (Opus
// codes it as speech: SILK; no two frames are alike).
static void voice_sig(int16_t *x, size_t n) {
  float ph = 0;
  for (size_t i = 0; i < n; i++) {
    float t = (float)i / VOICE_RATE, v = 0, f0 = 120.0f + 180.0f * t;
    ph += 6.2831853f * f0 / VOICE_RATE;
    for (int k = 1; (float)k * f0 < 7000; k++) v += sinf(ph * (float)k) / (float)k;
    v *= 0.6f + 0.4f * sinf(6.2831853f * 3.0f * t);
    x[i] = (int16_t)(v * 3000);
  }
}

/** Encodes and decodes `in`; returns the average packet size. */
static float round_trip(voice_codec_t c, const int16_t *in, int16_t *out, size_t n) {
  voice_tx_t tx;
  voice_rx_t rx;
  CHECK(voice_tx_open(&tx, c) && tx.codec == c);
  CHECK(voice_rx_open(&rx, c) && rx.codec == c);
  uint8_t pkt[VOICE_MAX_PACKET];
  size_t bytes = 0, frames = 0;
  for (size_t f = 0; f + VOICE_FRAME <= n; f += VOICE_FRAME) {
    size_t len = voice_encode(&tx, in + f, pkt, sizeof pkt);
    CHECK(len > 0);
    bytes += len;
    frames++;
    voice_decode(&rx, pkt, len, out + f);
  }
  voice_tx_close(&tx);
  voice_rx_close(&rx);
  return (float)bytes / (float)frames;
}

TEST(voice_opus_keeps_the_voice_band) {
  // A sweep of tones through Opus (complexity 1, for the board's CPU): each keeps its level within
  // 3 dB up to 3.5 kHz, like the telephone band and a little more; the bit rate stays near
  // 24 kbit/s over the sweep. (Complexity 5 kept 7 kHz but cost up to 24 ms per 20 ms frame.)
  static int16_t in[N], out[N];
  static const float hz[] = {200, 500, 1000, 2000, 3000, 3500};
  float total = 0;
  for (size_t i = 0; i < sizeof hz / sizeof hz[0]; i++) {
    tone(in, N, hz[i], 8000);
    float size = round_trip(VOICE_OPUS, in, out, N);
    total += size;
    float a = dsp_goertzel_dbfs(in + 3200, N - 3200, hz[i], VOICE_RATE);
    float b = dsp_goertzel_dbfs(out + 3200, N - 3200, hz[i], VOICE_RATE);
    CHECK_NEAR(b, a, 3);
    if (fabsf(b - a) > 3) fprintf(stderr, "    opus %.0f Hz: %.1f vs %.1f dBFS\n", hz[i], b, a);
  }
  float avg = total / (float)(sizeof hz / sizeof hz[0]);
  CHECK(avg > 15 && avg < 100);  // bytes per 20 ms: tones compress well; ~60 for speech
}

TEST(voice_pcmu_is_the_telephone_band) {
  static int16_t in[N], out[N];
  tone(in, N, 1000, 8000);
  CHECK(round_trip(VOICE_PCMU, in, out, N) == 160);
  CHECK_NEAR(dsp_goertzel_dbfs(out + 3200, N - 3200, 1000, VOICE_RATE),
             dsp_goertzel_dbfs(in + 3200, N - 3200, 1000, VOICE_RATE), 1);
  tone(in, N, 6000, 8000);  // above 4 kHz: gone (not folded into the band either)
  round_trip(VOICE_PCMU, in, out, N);
  CHECK(dsp_rms_dbfs(out + 3200, N - 3200) < -60);
}

/** Error energy (dB re the signal) of decoding `in` with packet `lost` (index) missing; `vs_next`:
 * the same frame's error against the frame after it (what decoding the next packet would give). */
static float loss_error(const int16_t *in, int lost, bool fec, uint32_t *fec_frames, float *vs_next) {
  static int16_t ref[N], got[N];
  voice_tx_t tx;
  voice_rx_t a, b;
  voice_tx_open(&tx, VOICE_OPUS);
  voice_rx_open(&a, VOICE_OPUS);
  voice_rx_open(&b, VOICE_OPUS);
  static uint8_t pkts[N / VOICE_FRAME][VOICE_MAX_PACKET];
  size_t lens[N / VOICE_FRAME];
  int frames = N / VOICE_FRAME;
  for (int f = 0; f < frames; f++) lens[f] = voice_encode(&tx, in + f * VOICE_FRAME, pkts[f], VOICE_MAX_PACKET);
  for (int f = 0; f < frames; f++) {
    voice_decode(&a, pkts[f], lens[f], ref + f * VOICE_FRAME);
    if (f == lost) voice_conceal(&b, fec ? pkts[f + 1] : NULL, fec ? lens[f + 1] : 0, got + f * VOICE_FRAME);
    else voice_decode(&b, pkts[f], lens[f], got + f * VOICE_FRAME);
  }
  double sig = 0, err = 0, errn = 0;
  for (int i = lost * VOICE_FRAME; i < (lost + 1) * VOICE_FRAME; i++) {
    sig += (double)ref[i] * ref[i];
    err += ((double)got[i] - ref[i]) * ((double)got[i] - ref[i]);
    double d = (double)got[i] - ref[i + VOICE_FRAME];
    errn += d * d;
  }
  if (vs_next) *vs_next = (float)(10 * log10((errn + 1) / (sig + 1)));
  *fec_frames = b.fec_frames;
  CHECK(b.concealed_frames == 1);
  voice_tx_close(&tx);
  voice_rx_close(&a);
  voice_rx_close(&b);
  return (float)(10 * log10((err + 1) / (sig + 1)));
}

TEST(voice_opus_fec_recovers_a_lost_packet) {
  // One packet lost at a time, at 20 places: decoded from the next packet's FEC copy, the frame is
  // on average much closer to the lost audio than with concealment alone.
  static int16_t in[N];
  voice_sig(in, N);
  float sum_fec = 0, sum_plc = 0, sum_next = 0;
  uint32_t fec_total = 0;
  for (int lost = 10; lost < 30; lost++) {
    uint32_t fec = 0, plc = 0;
    float vs_next;
    sum_fec += loss_error(in, lost, true, &fec, &vs_next);
    sum_next += vs_next;
    sum_plc += loss_error(in, lost, false, &plc, NULL);
    fec_total += fec;
    CHECK(plc == 0);
  }
  CHECK(fec_total == 20);
  float with_fec = sum_fec / 20, without = sum_plc / 20;
  CHECK(with_fec < without - 3);
  CHECK(with_fec < sum_next / 20 - 3);  // it is the lost frame, not the next one
  if (!(with_fec < without - 3))
    fprintf(stderr, "    mean error with FEC %.1f dB, without %.1f dB\n", with_fec, without);
}
