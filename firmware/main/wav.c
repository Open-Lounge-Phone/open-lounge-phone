#include "wav.h"

#include <string.h>

static uint32_t u32(const uint8_t *p) { return p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24; }
static uint16_t u16(const uint8_t *p) { return (uint16_t)(p[0] | p[1] << 8); }

bool wav_parse(const uint8_t *buf, size_t len, wav_t *out) {
  if (len < 12 || memcmp(buf, "RIFF", 4) || memcmp(buf + 8, "WAVE", 4)) return false;
  bool fmt_ok = false;
  size_t at = 12;
  while (at + 8 <= len) {
    uint32_t size = u32(buf + at + 4);
    const uint8_t *body = buf + at + 8;
    size_t room = len - (at + 8);
    if (!memcmp(buf + at, "fmt ", 4)) {
      if (size < 16 || room < 16) return false;
      // PCM, mono, 16-bit.
      if (u16(body) != 1 || u16(body + 2) != 1 || u16(body + 14) != 16) return false;
      out->rate = u32(body + 4);
      fmt_ok = out->rate >= 4000 && out->rate <= 48000;
    } else if (!memcmp(buf + at, "data", 4)) {
      if (!fmt_ok || ((uintptr_t)body & 1)) return false;
      size_t n = size < room ? size : room;  // a cut-off file plays what arrived
      out->samples = (const int16_t *)body;
      out->count = n / 2;
      return true;
    }
    if (size > room) return false;
    at += 8 + size + (size & 1);  // chunks are padded to even sizes
  }
  return false;
}
