// marquee.c: long names scroll in a loop.
#include "check.h"
#include "marquee.h"

TEST(marquee_fits_and_loops) {
  char o[32];
  marquee(o, sizeof o, "MOM", 8, 5);
  CHECK_STR(o, "MOM");
  const char *t = "CLAUDE TEST PHONE";  // 17 chars, room for 8
  marquee(o, sizeof o, t, 8, 0);
  CHECK_STR(o, "CLAUDE T");
  marquee(o, sizeof o, t, 8, MARQUEE_HOLD - 1);  // still holding at the start
  CHECK_STR(o, "CLAUDE T");
  marquee(o, sizeof o, t, 8, MARQUEE_HOLD + 1);
  CHECK_STR(o, "LAUDE TE");
  marquee(o, sizeof o, t, 8, MARQUEE_HOLD + 12);  // into the gap, then the start again
  CHECK_STR(o, "PHONE   ");
  marquee(o, sizeof o, t, 8, MARQUEE_HOLD + 14);
  CHECK_STR(o, "ONE   CL");
  marquee(o, sizeof o, t, 8, 17 + 3 + MARQUEE_HOLD);  // one full cycle later: the start
  CHECK_STR(o, "CLAUDE T");
  marquee(o, 4, t, 8, 0);  // never past the buffer
  CHECK_STR(o, "CLA");
}
