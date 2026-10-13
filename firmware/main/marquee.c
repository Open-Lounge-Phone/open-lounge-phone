#include "marquee.h"

#include <stdio.h>
#include <string.h>

#define GAP 3

void marquee(char *out, size_t n, const char *text, int width, long step) {
  int len = (int)strlen(text);
  if (width <= 0 || n == 0) {
    if (n) out[0] = '\0';
    return;
  }
  if (len <= width) {
    snprintf(out, n, "%s", text);
    return;
  }
  int cycle = len + GAP;
  long pos = step < 0 ? 0 : step % (cycle + MARQUEE_HOLD);
  int off = pos < MARQUEE_HOLD ? 0 : (int)(pos - MARQUEE_HOLD);
  int k = 0;
  for (; k < width && (size_t)k + 1 < n; k++) {
    int i = (off + k) % cycle;
    out[k] = i < len ? text[i] : ' ';
  }
  out[k] = '\0';
}
