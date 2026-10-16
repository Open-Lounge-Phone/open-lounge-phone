// 2:1 sample-rate conversion between the 16 kHz audio path and 8 kHz (G.711 calls, voicemail and
// greetings: "WAV everywhere" at 8 kHz). One half-band low-pass (63 taps, Kaiser beta 7): flat to
// 3.4 kHz (within 0.01 dB), at least 70 dB down from 4.6 kHz, so nothing above the telephone band
// folds into it going down, and no images above it coming up. Each way adds 31 samples at 16 kHz
// (about 2 ms). Pure C, host-tested.
#pragma once
#include <stddef.h>
#include <stdint.h>

#define RS_TAPS 63

typedef struct {
  float hist[RS_TAPS];
  int at;     // the newest sample's index in hist
  int phase;  // decimator: input samples seen mod 2
} rs_t;

void rs_init(rs_t *r);
/** 16 kHz → 8 kHz: n input samples (even), n/2 out. Returns the count written. */
size_t rs_down(rs_t *r, const int16_t *in, size_t n, int16_t *out);
/** 8 kHz → 16 kHz: n input samples, 2n out. Returns the count written. */
size_t rs_up(rs_t *r, const int16_t *in, size_t n, int16_t *out);
