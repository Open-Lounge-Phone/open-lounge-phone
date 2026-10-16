#include "fifo.h"

void fifo_init(fifo_t *f, int16_t *buf, uint32_t cap) {
  f->buf = buf;
  f->cap = cap;
  f->wr = f->rd = 0;
}

void fifo_reset(fifo_t *f) { f->rd = f->wr; }

uint32_t fifo_level(const fifo_t *f) { return f->wr - f->rd; }
uint32_t fifo_room(const fifo_t *f) { return f->cap - (f->wr - f->rd); }

uint32_t fifo_write(fifo_t *f, const int16_t *x, uint32_t n) {
  uint32_t room = fifo_room(f);
  if (n > room) n = room;
  uint32_t w = f->wr;
  for (uint32_t i = 0; i < n; i++) f->buf[(w + i) & (f->cap - 1)] = x[i];
  __atomic_thread_fence(__ATOMIC_RELEASE);
  f->wr = w + n;
  return n;
}

uint32_t fifo_read(fifo_t *f, int16_t *x, uint32_t n) {
  uint32_t level = fifo_level(f);
  __atomic_thread_fence(__ATOMIC_ACQUIRE);
  if (n > level) n = level;
  uint32_t r = f->rd;
  for (uint32_t i = 0; i < n; i++) x[i] = f->buf[(r + i) & (f->cap - 1)];
  __atomic_thread_fence(__ATOMIC_RELEASE);
  f->rd = r + n;
  return n;
}
