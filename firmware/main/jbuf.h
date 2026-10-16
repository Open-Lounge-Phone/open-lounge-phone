// The call's receive (jitter) buffer, docs/audio.md item 4: packets go in as they arrive (any
// order), and the audio task takes one 20 ms frame's worth every 20 ms. Playout starts once
// `target` ms are buffered: 60 ms at first, then adapting between 40 and 120 ms to the measured
// arrival jitter (RFC 3550's estimator). A missing packet is reported as lost (the caller conceals
// it; with the next packet at hand for Opus FEC). An empty buffer is concealed too, without moving
// on (that stretches the delay when packets come late); after 100 ms of nothing it buffers up
// again. Too much buffered for 200 ms (clock drift, a burst) drops a frame. Pure C, host-tested.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define JB_FRAME_MS 20
#define JB_SLOTS 16            // 320 ms of packets
#define JB_MAX_PACKET 400      // bytes (PCMU 20 ms: 160; Opus at 24 kbit/s: ~60)
#define JB_START_MS 60
#define JB_MIN_MS 40
#define JB_MAX_MS 120
#define JB_EMPTY_FRAMES 5      // concealed frames with nothing buffered before buffering again

typedef struct {
  bool used;
  uint32_t pts;
  uint16_t len;
  uint8_t data[JB_MAX_PACKET];
} jb_slot_t;

typedef struct {
  jb_slot_t slot[JB_SLOTS];
  bool started;      // a packet came (next/newest are set)
  bool playing;      // playout running (else buffering up to target)
  uint32_t next;     // pts of the frame to play next
  uint32_t newest;   // highest pts received
  // Jitter (RFC 3550 6.4.1, in ms) from arrival times against pts.
  bool have_last;
  int64_t last_arrival;
  uint32_t last_pts;
  float jitter_ms;
  int target_ms;
  int empty_run;     // concealed frames in a row with nothing buffered
  int deep_run;      // frames in a row with far more than target buffered
  uint8_t last_len;  // the last packet played (a 1-2 byte Opus DTX frame: silence, not loss)
  // Counters for the AUDIO log line (since jb_init).
  uint32_t received, played, concealed, late, dropped, rebuffers;
} jbuf_t;

typedef enum {
  JB_WAIT,    // buffering: play silence (or the end of a concealment)
  JB_PACKET,  // play `data`
  JB_LOST,    // conceal one frame; `next` is the following packet (Opus FEC) when at hand
} jb_kind_t;

typedef struct {
  jb_kind_t kind;
  const uint8_t *data;
  size_t len;
  const uint8_t *next;
  size_t next_len;
  bool dtx;  // a gap after a DTX frame (the sender went quiet on purpose): not counted as lost
} jb_out_t;

void jb_init(jbuf_t *jb);
/** A packet arrived at `arrival_ms` (any clock in ms). Its pts is in ms (20 ms per frame). */
void jb_put(jbuf_t *jb, uint32_t pts, const uint8_t *data, size_t len, int64_t arrival_ms);
/** One frame's worth, every 20 ms. The data pointers stay valid until the next jb_put. */
jb_out_t jb_get(jbuf_t *jb);
/** Buffered audio ahead of playout (ms): newest + one frame - next; 0 when empty. */
int jb_depth_ms(const jbuf_t *jb);
