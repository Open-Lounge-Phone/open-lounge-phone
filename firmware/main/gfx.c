// Text into a 1-bit framebuffer with a classic 5x7 font, scaled up. Two lines (the protocol's
// strip model, 16 chars) use 3x type; three or four lines (menus) use 2x.
#include "gfx.h"

#include <ctype.h>
#include <stdbool.h>
#include <string.h>

#include "sdkconfig.h"

// 5x7 font, ASCII 0x20-0x5F, one byte per column, LSB at the top.
static const uint8_t FONT[64][5] = {
    {0x00, 0x00, 0x00, 0x00, 0x00}, {0x00, 0x00, 0x5F, 0x00, 0x00}, {0x00, 0x07, 0x00, 0x07, 0x00},
    {0x14, 0x7F, 0x14, 0x7F, 0x14}, {0x24, 0x2A, 0x7F, 0x2A, 0x12}, {0x23, 0x13, 0x08, 0x64, 0x62},
    {0x36, 0x49, 0x56, 0x20, 0x50}, {0x00, 0x05, 0x03, 0x00, 0x00}, {0x00, 0x1C, 0x22, 0x41, 0x00},
    {0x00, 0x41, 0x22, 0x1C, 0x00}, {0x14, 0x08, 0x3E, 0x08, 0x14}, {0x08, 0x08, 0x3E, 0x08, 0x08},
    {0x00, 0x50, 0x30, 0x00, 0x00}, {0x08, 0x08, 0x08, 0x08, 0x08}, {0x00, 0x60, 0x60, 0x00, 0x00},
    {0x20, 0x10, 0x08, 0x04, 0x02}, {0x3E, 0x51, 0x49, 0x45, 0x3E}, {0x00, 0x42, 0x7F, 0x40, 0x00},
    {0x42, 0x61, 0x51, 0x49, 0x46}, {0x21, 0x41, 0x45, 0x4B, 0x31}, {0x18, 0x14, 0x12, 0x7F, 0x10},
    {0x27, 0x45, 0x45, 0x45, 0x39}, {0x3C, 0x4A, 0x49, 0x49, 0x30}, {0x01, 0x71, 0x09, 0x05, 0x03},
    {0x36, 0x49, 0x49, 0x49, 0x36}, {0x06, 0x49, 0x49, 0x29, 0x1E}, {0x00, 0x36, 0x36, 0x00, 0x00},
    {0x00, 0x56, 0x36, 0x00, 0x00}, {0x08, 0x14, 0x22, 0x41, 0x00}, {0x14, 0x14, 0x14, 0x14, 0x14},
    {0x00, 0x41, 0x22, 0x14, 0x08}, {0x02, 0x01, 0x51, 0x09, 0x06}, {0x32, 0x49, 0x79, 0x41, 0x3E},
    {0x7E, 0x11, 0x11, 0x11, 0x7E}, {0x7F, 0x49, 0x49, 0x49, 0x36}, {0x3E, 0x41, 0x41, 0x41, 0x22},
    {0x7F, 0x41, 0x41, 0x22, 0x1C}, {0x7F, 0x49, 0x49, 0x49, 0x41}, {0x7F, 0x09, 0x09, 0x09, 0x01},
    {0x3E, 0x41, 0x49, 0x49, 0x7A}, {0x7F, 0x08, 0x08, 0x08, 0x7F}, {0x00, 0x41, 0x7F, 0x41, 0x00},
    {0x20, 0x40, 0x41, 0x3F, 0x01}, {0x7F, 0x08, 0x14, 0x22, 0x41}, {0x7F, 0x40, 0x40, 0x40, 0x40},
    {0x7F, 0x02, 0x0C, 0x02, 0x7F}, {0x7F, 0x04, 0x08, 0x10, 0x7F}, {0x3E, 0x41, 0x41, 0x41, 0x3E},
    {0x7F, 0x09, 0x09, 0x09, 0x06}, {0x3E, 0x41, 0x51, 0x21, 0x5E}, {0x7F, 0x09, 0x19, 0x29, 0x46},
    {0x46, 0x49, 0x49, 0x49, 0x31}, {0x01, 0x01, 0x7F, 0x01, 0x01}, {0x3F, 0x40, 0x40, 0x40, 0x3F},
    {0x1F, 0x20, 0x40, 0x20, 0x1F}, {0x3F, 0x40, 0x38, 0x40, 0x3F}, {0x63, 0x14, 0x08, 0x14, 0x63},
    {0x07, 0x08, 0x70, 0x08, 0x07}, {0x61, 0x51, 0x49, 0x45, 0x43}, {0x00, 0x7F, 0x41, 0x41, 0x00},
    {0x02, 0x04, 0x08, 0x10, 0x20}, {0x00, 0x41, 0x41, 0x7F, 0x00}, {0x04, 0x02, 0x01, 0x02, 0x04},
    {0x40, 0x40, 0x40, 0x40, 0x40},
};

static void pixel(uint8_t *fb, int w, int h, int x, int y) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  fb[(y * w + x) / 8] |= 0x80 >> ((y * w + x) % 8);
}

static void glyph(uint8_t *fb, int w, int h, int x0, int y0, char c, int scale) {
  c = (char)toupper((unsigned char)c);
  if (c < 0x20 || c > 0x5F) c = '?';
  const uint8_t *g = FONT[c - 0x20];
  for (int col = 0; col < 5; col++)
    for (int row = 0; row < 7; row++)
      if (g[col] & (1 << row))
        for (int dx = 0; dx < scale; dx++)
          for (int dy = 0; dy < scale; dy++)
            pixel(fb, w, h, x0 + col * scale + dx, y0 + row * scale + dy);
}

static void ink(uint8_t *fb, int w, int h, int x, int y, bool on) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  uint8_t m = 0x80 >> ((y * w + x) % 8);
  if (on) fb[(y * w + x) / 8] |= m;
  else fb[(y * w + x) / 8] &= (uint8_t)~m;
}

void gfx_rect(uint8_t *fb, int w, int h, int x0, int y0, int rw, int rh, bool on) {
  for (int y = y0; y < y0 + rh; y++)
    for (int x = x0; x < x0 + rw; x++) ink(fb, w, h, x, y, on);
}
#define rect gfx_rect

int gfx_text_width(const char *str, int scale) { return (int)strlen(str) * 6 * scale - scale; }

void gfx_text_at(uint8_t *fb, int w, int h, int x0, int y, const char *str, int scale, bool on) {
  int len = (int)strlen(str), pitch = 6 * scale;
  for (int k = 0; k < len; k++) {
    char c = (char)toupper((unsigned char)str[k]);
    if (c < 0x20 || c > 0x5F) c = '?';
    const uint8_t *g = FONT[c - 0x20];
    for (int col = 0; col < 5; col++)
      for (int row = 0; row < 7; row++)
        if (g[col] & (1 << row)) rect(fb, w, h, x0 + k * pitch + col * scale, y + row * scale, scale, scale, on);
  }
}

void gfx_bitmap(uint8_t *fb, int w, int h, int x0, int y0, const uint8_t *bm, int bw, int bh) {
  int row = (bw + 7) / 8;
  for (int y = 0; y < bh; y++)
    for (int x = 0; x < bw; x++)
      if (bm[y * row + x / 8] & (0x80 >> (x % 8))) ink(fb, w, h, x0 + x, y0 + y, true);
}

#if CONFIG_OLP_UI_V2
// The framed look (CONFIG_OLP_UI_V2): status screens get the main line large over a rule;
// screens with 3-4 lines get their first line as a black title bar and dotted separators.
static void text(uint8_t *fb, int w, int h, const char *str, int y, int scale, bool on) {
  gfx_text_at(fb, w, h, (w - gfx_text_width(str, scale)) / 2, y, str, scale, on);
}

/** The largest scale (up to `max`) at which `str` fits `room` pixels. */
static int fit(const char *str, int room, int max) {
  int len = (int)strlen(str), s = max;
  while (s > 1 && len * 6 * s - s > room) s--;
  return s;
}

static void dotted(uint8_t *fb, int w, int h, int y, int margin) {
  for (int x = margin; x < w - margin; x += 3) ink(fb, w, h, x, y, true);
}

static void frame(uint8_t *fb, int w, int h) {
  rect(fb, w, h, 3, 1, w - 6, 1, true);       // a thin border with clipped corners
  rect(fb, w, h, 3, h - 2, w - 6, 1, true);
  rect(fb, w, h, 1, 3, 1, h - 6, true);
  rect(fb, w, h, w - 2, 3, 1, h - 6, true);
  ink(fb, w, h, 2, 2, true);
  ink(fb, w, h, w - 3, 2, true);
  ink(fb, w, h, 2, h - 3, true);
  ink(fb, w, h, w - 3, h - 3, true);
}

void gfx_render_lines(uint8_t *fb, int w, int h, const char *const *lines, int n) {
  memset(fb, 0, (size_t)(w * h + 7) / 8);
  if (n <= 0) return;
  frame(fb, w, h);
  int room = w - 20;
  if (n == 1) {
    int s = fit(lines[0], room, 3), th = 7 * s;
    int y = (h - th) / 2;
    text(fb, w, h, lines[0], y, s, true);
    rect(fb, w, h, w / 3, y - 12, w / 3, 2, true);
    rect(fb, w, h, w / 3, y + th + 10, w / 3, 2, true);
    return;
  }
  if (n == 2) {
    int s0 = fit(lines[0], room, 3), s1 = fit(lines[1], room, 2);
    int block = 7 * s0 + 12 + 2 + 12 + 7 * s1;
    int y = (h - block) / 2;
    text(fb, w, h, lines[0], y, s0, true);
    y += 7 * s0 + 12;
    rect(fb, w, h, 14, y, w - 28, 2, true);
    text(fb, w, h, lines[1], y + 2 + 12, s1, true);
    return;
  }
  // 3-4 lines: a title bar, then the rest with dotted separators
  int bar = 7 * 2 + 10;
  rect(fb, w, h, 4, 4, w - 8, bar, true);
  text(fb, w, h, lines[0], 4 + 5, fit(lines[0], w - 16, 2), false);
  int items = n - 1, top = 4 + bar, slot = (h - 4 - top) / items;
  for (int i = 0; i < items; i++) {
    int s = fit(lines[i + 1], w - 10, 2);
    text(fb, w, h, lines[i + 1], top + i * slot + (slot - 7 * s) / 2, s, true);
    if (i < items - 1) dotted(fb, w, h, top + (i + 1) * slot, 12);
  }
}
#else
void gfx_render_lines(uint8_t *fb, int w, int h, const char *const *lines, int n) {
  memset(fb, 0, (size_t)(w * h + 7) / 8);
  if (n <= 0) return;
  // Largest scale where 16 chars (6 px pitch) fit the width and n lines fit the height.
  int scale = n <= 2 ? 3 : 2;
  while (scale > 1 && (16 * 6 * scale > w || n * 10 * scale > h)) scale--;
  int pitch = 6 * scale, line_h = 7 * scale, gap = 3 * scale;
  int total = n * line_h + (n - 1) * gap;
  int y = (h - total) / 2;
  for (int i = 0; i < n; i++, y += line_h + gap) {
    int len = (int)strlen(lines[i]);
    int x = (w - (len * pitch - scale)) / 2;
    for (int k = 0; k < len; k++) glyph(fb, w, h, x + k * pitch, y, lines[i][k], scale);
  }
}
#endif
