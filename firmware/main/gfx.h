#pragma once
#include <stdint.h>

/** Draw up to 4 centred lines into a 1-bit framebuffer (cleared first). */
void gfx_render_lines(uint8_t *fb, int w, int h, const char *const *lines, int n);
