#pragma once
#include <stdbool.h>
#include <stdint.h>

/** Draw up to 4 centred lines into a 1-bit framebuffer (cleared first). */
void gfx_render_lines(uint8_t *fb, int w, int h, const char *const *lines, int n);
/** Drawing helpers for pixel screens (boot, setup QR, games). 1 = black. */
void gfx_rect(uint8_t *fb, int w, int h, int x, int y, int rw, int rh, bool on);
void gfx_text_at(uint8_t *fb, int w, int h, int x, int y, const char *str, int scale, bool on);
int gfx_text_width(const char *str, int scale);
void gfx_bitmap(uint8_t *fb, int w, int h, int x, int y, const uint8_t *bm, int bw, int bh);
