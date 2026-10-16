#include <stdlib.h>

#include "check.h"
#include "jbuf.h"

// A small network: packets (pts every 20 ms) arrive at given times; every 20 ms the playout takes
// one frame. Each packet's payload is its pts, so what plays can be checked.
typedef struct {
  uint32_t pts;
  int64_t at;
  uint8_t len;
} pkt_t;

typedef struct {
  int packets, lost, waits, fec, dtx;
  uint32_t last_played;
  bool order_ok;
} played_t;

static played_t run(jbuf_t *jb, pkt_t *p, int n, int64_t until_ms) {
  played_t r = {.order_ok = true};
  bool any = false;
  uint32_t last = 0;  // it stops once the last packet played (what follows is the call's end)
  for (int i = 0; i < n; i++)
    if (p[i].at < 1000000 && p[i].pts > last) last = p[i].pts;
  // Arrivals in time order (the array may be in any order).
  for (int64_t t = 0; t <= until_ms; t += 20) {
    for (int i = 0; i < n; i++) {
      if (p[i].at > t - 20 && p[i].at <= t) {
        uint8_t buf[8] = {0};
        memcpy(buf, &p[i].pts, 4);
        jb_put(jb, p[i].pts, buf, p[i].len ? p[i].len : 8, p[i].at);
      }
    }
    jb_out_t o = jb_get(jb);
    if (o.kind == JB_WAIT) {
      r.waits++;
    } else if (o.kind == JB_LOST) {
      if (o.dtx) r.dtx++;
      else r.lost++;
      if (o.next) r.fec++;
    } else {
      uint32_t pts;
      memcpy(&pts, o.data, 4);
      if (any && pts <= r.last_played) r.order_ok = false;
      r.last_played = pts;
      any = true;
      r.packets++;
      if (pts == last) break;
    }
  }
  return r;
}

static uint32_t seed = 1;
static int rnd(int max) {
  seed = seed * 1103515245u + 12345u;
  return (int)((seed >> 16) % (uint32_t)(max + 1));
}

TEST(jb_plays_in_order_after_60_ms) {
  jbuf_t jb;
  jb_init(&jb);
  pkt_t p[100];
  for (int i = 0; i < 100; i++) p[i] = (pkt_t){.pts = 1000 + 20 * (uint32_t)i, .at = 20 * i};
  played_t r = run(&jb, p, 100, 2100);
  CHECK(r.order_ok);
  CHECK(r.packets == 100);
  CHECK(r.lost == 0);
  CHECK(r.waits >= 2 && r.waits <= 4);  // the first 60 ms buffer up
  CHECK(jb.late == 0 && jb.concealed == 0);
}

TEST(jb_reorders) {
  jbuf_t jb;
  jb_init(&jb);
  pkt_t p[100];
  for (int i = 0; i < 100; i++) p[i] = (pkt_t){.pts = 20 * (uint32_t)i, .at = 20 * i};
  for (int i = 10; i < 90; i += 2) {  // every pair arrives swapped
    int64_t t = p[i].at;
    p[i].at = p[i + 1].at;
    p[i + 1].at = t;
  }
  played_t r = run(&jb, p, 100, 2200);
  CHECK(r.order_ok);
  CHECK(r.packets == 100 && r.lost == 0);
}

TEST(jb_reports_a_lost_packet_with_the_next_for_fec) {
  jbuf_t jb;
  jb_init(&jb);
  pkt_t p[100];
  for (int i = 0; i < 100; i++) p[i] = (pkt_t){.pts = 20 * (uint32_t)i, .at = 20 * i};
  p[40].at = 1000000;  // never comes
  p[70].at = 1000000;
  played_t r = run(&jb, p, 100, 2200);
  CHECK(r.order_ok);
  CHECK(r.packets == 98);
  CHECK(r.lost == 2);
  CHECK(r.fec == 2);  // the next packet was there both times
  CHECK(jb.concealed == 2);
}

TEST(jb_adapts_to_jitter) {
  jbuf_t jb;
  jb_init(&jb);
  // A steady network: the target settles at the minimum, 40 ms.
  static pkt_t p[500];
  for (int i = 0; i < 500; i++) p[i] = (pkt_t){.pts = 20 * (uint32_t)i, .at = 20 * i + 3};
  run(&jb, p, 500, 10000);
  CHECK(jb.target_ms == JB_MIN_MS);
  CHECK(jb.concealed == 0);
  // A jittery one (each packet 0-60 ms late): a deeper target, and few packets too late.
  jb_init(&jb);
  for (int i = 0; i < 500; i++) p[i] = (pkt_t){.pts = 20 * (uint32_t)i, .at = 20 * i + rnd(60)};
  played_t r = run(&jb, p, 500, 10200);
  CHECK(jb.target_ms > JB_START_MS && jb.target_ms <= JB_MAX_MS);
  CHECK(r.lost < 25);  // under 5 %
  CHECK(jb.late < 25);
}

TEST(jb_underrun_stretches_then_buffers_up) {
  jbuf_t jb;
  jb_init(&jb);
  pkt_t p[100];
  // 1 s of packets, nothing for 300 ms, then the rest arrives (delayed by that much).
  for (int i = 0; i < 100; i++)
    p[i] = (pkt_t){.pts = 20 * (uint32_t)i, .at = 20 * i + (i >= 50 ? 300 : 0)};
  played_t r = run(&jb, p, 100, 2600);
  CHECK(r.order_ok);
  CHECK(r.packets == 100);  // nothing was thrown away: the delay grew instead
  CHECK(jb.late == 0);
  CHECK(jb.rebuffers >= 1);
  CHECK(r.lost == JB_EMPTY_FRAMES);  // concealed until it gave up and buffered up again
}

TEST(jb_keeps_delay_bounded_when_the_sender_runs_fast) {
  jbuf_t jb;
  jb_init(&jb);
  static pkt_t p[600];
  // The sender's clock runs 5 % fast: packets every 19 ms.
  for (int i = 0; i < 600; i++) p[i] = (pkt_t){.pts = 20 * (uint32_t)i, .at = 19 * i};
  int max_depth = 0;
  for (int64_t t = 0; t <= 11400; t += 20) {
    for (int i = 0; i < 600; i++) {
      if (p[i].at > t - 20 && p[i].at <= t) {
        uint8_t b[4] = {0};
        jb_put(&jb, p[i].pts, b, 4, p[i].at);
      }
    }
    jb_get(&jb);
    if (t > 2000 && jb_depth_ms(&jb) > max_depth) max_depth = jb_depth_ms(&jb);
  }
  CHECK(jb.dropped > 10);
  CHECK(max_depth <= jb.target_ms + 3 * JB_FRAME_MS);
}

TEST(jb_dtx_gap_is_not_loss) {
  jbuf_t jb;
  jb_init(&jb);
  pkt_t p[60];
  int n = 0;
  for (int i = 0; i < 20; i++) p[n++] = (pkt_t){.pts = 20 * (uint32_t)i, .at = 20 * i};
  p[n - 1].len = 1;  // a DTX frame, then 400 ms of nothing (the sender is quiet)
  for (int i = 40; i < 60; i++) p[n++] = (pkt_t){.pts = 20 * (uint32_t)i, .at = 20 * i};
  played_t r = run(&jb, p, n, 1400);
  CHECK(r.dtx > 0);
  CHECK(jb.concealed == 0);
  CHECK(r.lost == 0);
}

TEST(jb_restarts_on_a_new_timeline) {
  jbuf_t jb;
  jb_init(&jb);
  pkt_t p[40];
  for (int i = 0; i < 20; i++) p[i] = (pkt_t){.pts = 20 * (uint32_t)i, .at = 20 * i};
  for (int i = 20; i < 40; i++) p[i] = (pkt_t){.pts = 900000 + 20 * (uint32_t)i, .at = 20 * i};
  played_t r = run(&jb, p, 40, 1000);
  CHECK(r.packets >= 34);
  CHECK(jb.rebuffers == 1);
  CHECK(jb.late == 0);
}
