#include "check.h"
#include "fifo.h"

TEST(fifo_keeps_order_and_bounds) {
  int16_t buf[8], out[8];
  fifo_t f;
  fifo_init(&f, buf, 8);
  int16_t a[5] = {1, 2, 3, 4, 5};
  CHECK(fifo_write(&f, a, 5) == 5);
  CHECK(fifo_write(&f, a, 5) == 3);  // only what fits
  CHECK(fifo_level(&f) == 8 && fifo_room(&f) == 0);
  CHECK(fifo_read(&f, out, 6) == 6);
  CHECK(out[0] == 1 && out[4] == 5 && out[5] == 1);
  CHECK(fifo_write(&f, a, 5) == 5);  // wraps around
  CHECK(fifo_read(&f, out, 8) == 7);
  CHECK(out[0] == 2 && out[1] == 3 && out[2] == 1 && out[6] == 5);
  CHECK(fifo_level(&f) == 0);
}
