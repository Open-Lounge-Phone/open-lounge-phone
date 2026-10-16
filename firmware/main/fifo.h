// A single-producer, single-consumer sample FIFO (one task writes, another reads; no locks):
// the audio pump and the audio task hand samples to each other through these. Pure C.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
  int16_t *buf;
  uint32_t cap;                // a power of two
  volatile uint32_t wr, rd;    // free-running counters
} fifo_t;

void fifo_init(fifo_t *f, int16_t *buf, uint32_t cap);
void fifo_reset(fifo_t *f);  // only while neither side runs
uint32_t fifo_level(const fifo_t *f);
uint32_t fifo_room(const fifo_t *f);
/** Writes up to n (what fits); returns the count. */
uint32_t fifo_write(fifo_t *f, const int16_t *x, uint32_t n);
/** Reads up to n (what's there); returns the count. */
uint32_t fifo_read(fifo_t *f, int16_t *x, uint32_t n);
