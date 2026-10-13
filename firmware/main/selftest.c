#include "selftest.h"

#include <stdio.h>
#include <string.h>

#include "gfx.h"

#define KEYS 12

static struct {
  bool active, dirty;
  bool key[KEYS];
  bool hook_up, hook_down;  // seen in each position (after a change)
  bool hook_now, jack_now;
  bool jack_in, jack_out;   // seen changing each way
  int64_t last_input, done_at;
} s;

void selftest_start(int64_t now_ms, bool hook_up, bool jack_in) {
  memset(&s, 0, sizeof s);
  s.active = s.dirty = true;
  s.hook_now = hook_up;
  s.jack_now = jack_in;
  s.last_input = now_ms;
  s.done_at = -1;
}

bool selftest_active(void) { return s.active; }
bool selftest_dirty(void) { return s.dirty; }

bool selftest_passed(void) {
  for (int i = 0; i < KEYS; i++)
    if (!s.key[i]) return false;
  return s.hook_up && s.hook_down;
}

static void touched(int64_t now_ms) {
  s.last_input = now_ms;
  s.dirty = true;
  if (s.done_at < 0 && selftest_passed()) s.done_at = now_ms;
}

void selftest_key(int index, int64_t now_ms) {
  if (!s.active || index < 0 || index >= KEYS) return;
  s.key[index] = true;
  touched(now_ms);
}

void selftest_hook(bool up, int64_t now_ms) {
  if (!s.active || up == s.hook_now) return;
  s.hook_now = up;
  if (up) s.hook_up = true;
  else s.hook_down = true;
  touched(now_ms);
}

void selftest_jack(bool in, int64_t now_ms) {
  if (!s.active || in == s.jack_now) return;
  s.jack_now = in;
  if (in) s.jack_in = true;
  else s.jack_out = true;
  touched(now_ms);
}

bool selftest_tick(int64_t now_ms) {
  if (!s.active) return false;
  bool done = s.done_at >= 0 && now_ms - s.done_at >= SELFTEST_DONE_MS;
  if (done || now_ms - s.last_input >= SELFTEST_IDLE_MS) {
    s.active = false;
    return true;
  }
  return false;
}

// --- drawing --------------------------------------------------------------------------------

static void box(uint8_t *fb, int w, int h, int x, int y, int bw, int bh, bool filled,
                const char *label, int scale) {
  if (filled) {
    gfx_rect(fb, w, h, x, y, bw, bh, true);
  } else {
    gfx_rect(fb, w, h, x, y, bw, 1, true);
    gfx_rect(fb, w, h, x, y + bh - 1, bw, 1, true);
    gfx_rect(fb, w, h, x, y, 1, bh, true);
    gfx_rect(fb, w, h, x + bw - 1, y, 1, bh, true);
  }
  int tw = gfx_text_width(label, scale);
  gfx_text_at(fb, w, h, x + (bw - tw) / 2, y + (bh - 7 * scale) / 2, label, scale, !filled);
}

void selftest_draw(uint8_t *fb, int w, int h) {
  s.dirty = false;
  memset(fb, 0, (size_t)(w * h + 7) / 8);
  gfx_rect(fb, w, h, 0, 0, w, 22, true);
  const char *title = "SELF-TEST";
  gfx_text_at(fb, w, h, (w - gfx_text_width(title, 2)) / 2, 4, title, 2, false);

  // The keypad as it sits on the phone: 1 2 3 4 5 MENU / 6 7 8 9 0 BACK (protocol indexes).
  static const int rows[2][6] = {{0, 1, 2, 3, 4, 10}, {5, 6, 7, 8, 9, 11}};
  static const char *labels[KEYS] = {"1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "MENU", "BACK"};
  const int bw = 28, bh = 22, gap = 4, side = 40;
  int x0 = (w - (6 * (bw + gap) + 2 + side)) / 2, y0 = 28;
  for (int r = 0; r < 2; r++) {
    for (int c = 0; c < 6; c++) {
      int k = rows[r][c];
      box(fb, w, h, x0 + c * (bw + gap), y0 + r * (bh + gap), bw, bh, s.key[k], labels[k],
          k >= 10 ? 1 : 2);
    }
  }
  int sx = x0 + 6 * (bw + gap) + 2;
  box(fb, w, h, sx, y0, side, bh, s.hook_up && s.hook_down, "HOOK", 1);
  box(fb, w, h, sx, y0 + bh + gap, side, bh, s.jack_in && s.jack_out, "JACK", 1);

  int y = y0 + 2 * (bh + gap) + 4;
  if (s.done_at >= 0) {
    const char *ok = "ALL GOOD";
    gfx_text_at(fb, w, h, (w - gfx_text_width(ok, 2)) / 2, y + 4, ok, 2, true);
    return;
  }
  const char *a = "PRESS EVERY KEY, LIFT + HANG UP";
  const char *b = "HANDSET UP: A 1 KHZ TONE";
  gfx_text_at(fb, w, h, (w - gfx_text_width(a, 1)) / 2, y, a, 1, true);
  gfx_text_at(fb, w, h, (w - gfx_text_width(b, 1)) / 2, y + 12, b, 1, true);
  char hook[24];
  snprintf(hook, sizeof hook, "HANDSET %s, JACK %s", s.hook_now ? "UP" : "DOWN",
           s.jack_now ? "IN" : "OUT");
  gfx_text_at(fb, w, h, (w - gfx_text_width(hook, 1)) / 2, y + 24, hook, 1, true);
}

void selftest_stop(void) { s.active = false; }
