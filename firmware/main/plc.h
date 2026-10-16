// Packet loss concealment for G.711 (PCMU), in the style of ITU-T G.711 Appendix I (docs/audio.md
// item 4): on a lost frame it repeats the last pitch period (found by autocorrelation, 5-15 ms),
// blended into the real signal over a quarter period; after 10 ms it fades out, reaching silence
// at 60 ms; when audio returns it cross-fades back. To blend the start the output runs 3.75 ms
// behind the input (as in Appendix I). Opus has its own concealment. Pure C, host-tested.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PLC_MAX_RATE 16000
#define PLC_HIST (PLC_MAX_RATE * 48 / 1000)   // 48 ms of history (pitch search + the delay)
#define PLC_MAX_FRAME (PLC_MAX_RATE * 20 / 1000)

typedef struct {
  int rate;
  int delay;       // samples the output runs behind (3.75 ms)
  int16_t hist[PLC_HIST];  // the signal as played (real or made up), newest last
  int lost;        // samples made up in the current loss (0: not concealing)
  int pitch;       // the period being repeated
  int pos;         // where in it
  int16_t period[PLC_MAX_RATE * 15 / 1000];  // the repeated period
  uint32_t concealed_frames;
} plc_t;

void plc_init(plc_t *p, int rate);
/** A frame arrived: `in` (n samples) goes in, `out` gets n samples (3.75 ms behind). */
void plc_good(plc_t *p, const int16_t *in, int16_t *out, size_t n);
/** A frame is missing: `out` gets n made-up samples. */
void plc_lost(plc_t *p, int16_t *out, size_t n);
