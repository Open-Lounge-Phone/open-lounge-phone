// Reading a WAV file (voicemail from `GET /api/vm/play`): the PCM data of a 16-bit mono file.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint32_t rate;
  const int16_t *samples;  // points into the buffer (little-endian, like the ESP32)
  size_t count;
} wav_t;

/** Finds the `fmt ` and `data` chunks; only 16-bit PCM mono is accepted. */
bool wav_parse(const uint8_t *buf, size_t len, wav_t *out);
