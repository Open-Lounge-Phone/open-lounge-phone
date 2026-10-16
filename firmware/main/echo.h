// Echo removal for the handset (docs/audio.md item 5): what the earpiece played (the reference,
// after volume) leaking back into the mic.
//  - It always measures the echo return loss (ERL) in calls: how much quieter the echo in the mic
//    is than what was played, over the moments the other side talks.
//  - With the canceller on: SpeexDSP's echo canceller (a frequency-domain adaptive NLMS filter,
//    64 ms tail) plus its residual echo suppressor; it also reports how much echo it removed (ERLE).
//  - The phone check's echo test plays a sweep and measures ERL and the loop delay (earpiece to mic:
//    the same path as the sidetone's delay).
// Pure C (SpeexDSP's API), host-tested.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define ECHO_TAIL_MS 64
#define ECHO_ACTIVE_DBFS (-45.0f)  // reference frames louder than this count for the ERL
#define ECHO_POOR_DB 30.0f         // ERL below this: echo that people notice (cancel it)
#define ECHO_GOOD_DB 45.0f

typedef struct {
  void *aec, *pp;  // SpeexEchoState, SpeexPreprocessState (NULL: canceller off)
  int rate, frame;
  // The ERL meter (one-second windows of frames where the reference is active).
  double ref_e, mic_e, out_e;
  int active, frames;
  float erl_db;       // the last window's (-1: none yet)
  float erl_best_db;  // the call's highest window (least disturbed by the near end talking)
  float erle_db;      // echo removed by the canceller in the last window (0: off)
} echo_t;

/** Memory for SpeexDSP's states (weak: calloc; the phone puts them in PSRAM). */
void *echo_alloc(size_t size);
void echo_free(void *p);
/** SpeexDSP's warnings so far (the canceller resetting itself after diverging). */
uint32_t echo_warnings(void);

/** Opens the canceller when `cancel` (else it only measures). False if it can't allocate. */
bool echo_open(echo_t *e, int rate, int frame, bool cancel);
void echo_close(echo_t *e);
/** One frame: `mic` (in place: echo removed when on) and the reference played meanwhile. */
void echo_process(echo_t *e, int16_t *mic, const int16_t *ref);

// --- the phone check's echo test ------------------------------------------------------------
#define ECHO_TEST_QUIET_MS 300  // the mic's noise first
#define ECHO_TEST_SWEEP_MS 1500 // then a sweep 200 Hz to 7 kHz
#define ECHO_TEST_TAIL_MS 200   // and the echo's tail

/** Sample `i` of the test's earpiece signal (silence, then the sweep at -20 dBFS, silence). */
int16_t echo_test_sample(size_t i, int rate);
size_t echo_test_len(int rate);

typedef struct {
  bool heard;      // the sweep came back above the noise
  float erl_db;    // when heard: the loss; else at least this much
  float delay_ms;  // when heard: earpiece to mic
  float noise_dbfs;
} echo_result_t;

/** From the test's reference (what was played) and mic, aligned sample by sample. */
echo_result_t echo_test_measure(const int16_t *ref, const int16_t *mic, size_t n, int rate);
/** "GOOD" / "OK" / "POOR" for an ERL. */
const char *echo_word(float erl_db);
