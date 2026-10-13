// wav.c: the voicemail files phones play.
#include <stdint.h>
#include <string.h>

#include "check.h"
#include "wav.h"

static size_t make(uint8_t *b, uint16_t fmt, uint16_t ch, uint16_t bits, uint32_t rate, int extra) {
  size_t at = 0;
  memcpy(b, "RIFF\0\0\0\0WAVE", 12);
  at = 12;
  if (extra) {  // an unknown chunk first, odd-sized (padded)
    memcpy(b + at, "LIST\3\0\0\0abc\0", 12);
    at += 12;
  }
  memcpy(b + at, "fmt \x10\0\0\0", 8);
  uint8_t f[16] = {(uint8_t)fmt, 0, (uint8_t)ch, 0, (uint8_t)rate, (uint8_t)(rate >> 8), 0, 0,
                   0, 0, 0, 0, 2, 0, (uint8_t)bits, 0};
  memcpy(b + at + 8, f, 16);
  at += 24;
  memcpy(b + at, "data\6\0\0\0", 8);
  int16_t s[3] = {1, -2, 300};
  memcpy(b + at + 8, s, 6);
  return at + 14;
}

TEST(wav_reads_8khz_pcm) {
  uint8_t b[96] __attribute__((aligned(2)));
  wav_t w;
  size_t n = make(b, 1, 1, 16, 8000, 0);
  CHECK(wav_parse(b, n, &w));
  CHECK(w.rate == 8000 && w.count == 3 && w.samples[1] == -2 && w.samples[2] == 300);
  n = make(b, 1, 1, 16, 8000, 1);
  CHECK(wav_parse(b, n, &w) && w.count == 3);
  CHECK(wav_parse(b, n - 2, &w) && w.count == 2);  // cut off: what arrived
}

TEST(wav_refuses_other_formats) {
  uint8_t b[96] __attribute__((aligned(2)));
  wav_t w;
  CHECK(!wav_parse(b, make(b, 7, 1, 16, 8000, 0), &w));  // mu-law
  CHECK(!wav_parse(b, make(b, 1, 2, 16, 8000, 0), &w));  // stereo
  CHECK(!wav_parse(b, make(b, 1, 1, 8, 8000, 0), &w));   // 8-bit
  CHECK(!wav_parse(b, make(b, 1, 1, 16, 8000, 0) - 20, &w));  // no data chunk
  CHECK(!wav_parse((const uint8_t *)"OggS", 4, &w));
}
