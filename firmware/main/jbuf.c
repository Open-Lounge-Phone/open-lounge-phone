#include "jbuf.h"

#include <math.h>
#include <string.h>

#define DEEP_FRAMES 10  // 200 ms with too much buffered: drop a frame

static int32_t diff(uint32_t a, uint32_t b) { return (int32_t)(a - b); }

static jb_slot_t *slot_for(jbuf_t *jb, uint32_t pts) {
  return &jb->slot[(pts / JB_FRAME_MS) % JB_SLOTS];
}

static jb_slot_t *find(jbuf_t *jb, uint32_t pts) {
  jb_slot_t *s = slot_for(jb, pts);
  return s->used && s->pts == pts ? s : NULL;
}

void jb_init(jbuf_t *jb) {
  memset(jb, 0, sizeof *jb);
  jb->target_ms = JB_START_MS;
}

int jb_depth_ms(const jbuf_t *jb) {
  if (!jb->started) return 0;
  int32_t d = diff(jb->newest, jb->next) + JB_FRAME_MS;
  return d > 0 ? d : 0;
}

static void restart(jbuf_t *jb, uint32_t pts) {
  for (int i = 0; i < JB_SLOTS; i++) jb->slot[i].used = false;
  jb->next = jb->newest = pts;
  jb->playing = false;
  jb->empty_run = jb->deep_run = 0;
}

void jb_put(jbuf_t *jb, uint32_t pts, const uint8_t *data, size_t len, int64_t arrival_ms) {
  if (len > JB_MAX_PACKET) len = JB_MAX_PACKET;
  pts -= pts % JB_FRAME_MS;  // frames are 20 ms apart; a sender's ms rounding doesn't matter
  jb->received++;
  // Jitter: how much the spacing of arrivals differs from the spacing of the timestamps.
  if (jb->have_last && diff(pts, jb->last_pts) > 0) {
    float d = (float)((arrival_ms - jb->last_arrival) - diff(pts, jb->last_pts));
    jb->jitter_ms += (fabsf(d) - jb->jitter_ms) / 16.0f;
  }
  if (!jb->have_last || diff(pts, jb->last_pts) > 0) {
    jb->have_last = true;
    jb->last_arrival = arrival_ms;
    jb->last_pts = pts;
  }
  if (!jb->started) {
    jb->started = true;
    restart(jb, pts);
  }
  int32_t ahead = diff(pts, jb->next);
  if (ahead < 0) {  // its time has passed (it was concealed)
    jb->late++;
    return;
  }
  if (ahead >= JB_SLOTS * JB_FRAME_MS) {
    // Far ahead: the sender's timeline jumped (a new stream). Start over from here.
    jb->rebuffers++;
    restart(jb, pts);
  }
  jb_slot_t *s = slot_for(jb, pts);
  s->used = true;
  s->pts = pts;
  s->len = (uint16_t)len;
  memcpy(s->data, data, len);
  if (diff(pts, jb->newest) > 0) jb->newest = pts;
}

/** The target from the jitter: a frame plus four times the mean deviation, within 40-120 ms. */
static void retarget(jbuf_t *jb) {
  if (jb->received < 50) return;  // the first second: the start value
  int t = (int)(30.0f + 3.0f * jb->jitter_ms + 0.5f);
  jb->target_ms = t < JB_MIN_MS ? JB_MIN_MS : t > JB_MAX_MS ? JB_MAX_MS : t;
}

jb_out_t jb_get(jbuf_t *jb) {
  jb_out_t out = {.kind = JB_WAIT};
  retarget(jb);
  if (!jb->started) return out;
  int depth = jb_depth_ms(jb);
  if (!jb->playing) {
    if (depth < jb->target_ms) return out;
    jb->playing = true;
    jb->empty_run = 0;
  }
  // Too much buffered for a while (the sender's clock runs fast, or a burst came): skip a frame.
  if (depth > jb->target_ms + 2 * JB_FRAME_MS) {
    if (++jb->deep_run >= DEEP_FRAMES || depth > JB_MAX_MS + 3 * JB_FRAME_MS) {
      jb_slot_t *s = find(jb, jb->next);
      if (s) s->used = false;
      jb->next += JB_FRAME_MS;
      jb->dropped++;
      jb->deep_run = 0;
      depth = jb_depth_ms(jb);
    }
  } else {
    jb->deep_run = 0;
  }
  jb_slot_t *s = find(jb, jb->next);
  if (s) {
    s->used = false;  // the data stays readable until the slot is written again
    out.kind = JB_PACKET;
    out.data = s->data;
    out.len = s->len;
    jb->last_len = (uint8_t)(s->len > 255 ? 255 : s->len);
    jb->next += JB_FRAME_MS;
    jb->played++;
    jb->empty_run = 0;
    return out;
  }
  out.kind = JB_LOST;
  out.dtx = jb->last_len > 0 && jb->last_len <= 2;
  if (!out.dtx) jb->concealed++;
  if (depth > JB_FRAME_MS) {
    // A gap with packets after it: this one is lost. The next one may carry it (Opus FEC).
    jb_slot_t *n = find(jb, jb->next + JB_FRAME_MS);
    if (n) {
      out.next = n->data;
      out.next_len = n->len;
    }
    jb->next += JB_FRAME_MS;
    jb->empty_run = 0;
    return out;
  }
  // Nothing buffered: conceal without moving on (a late packet can still play: more delay).
  if (++jb->empty_run >= JB_EMPTY_FRAMES) {
    jb->playing = false;  // buffer up again
    jb->rebuffers++;
    jb->empty_run = 0;
  }
  return out;
}
