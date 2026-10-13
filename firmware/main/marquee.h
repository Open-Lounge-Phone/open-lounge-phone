// Looping scroll for text longer than its space (docs/phone-ux.md): the window starts at the
// beginning, holds there a moment, then moves one character per step through the text and a
// gap, round again.
#pragma once
#include <stddef.h>

#define MARQUEE_STEP_MS 600  // one character per step (an e-paper partial refresh each)
#define MARQUEE_HOLD 3       // steps at the start before it moves

/** The `width` characters of `text` to show at `step`; `text` itself when it fits. */
void marquee(char *out, size_t n, const char *text, int width, long step);
