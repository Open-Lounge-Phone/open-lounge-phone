// calls.c: missed calls' times and redial's memory (mirrors packages/core missed.test.ts).
#include "calls.h"
#include "check.h"

TEST(calls_missed_when_today_yesterday_or_the_date) {
  // Tuesday 2026-10-13 14:05 UTC.
  const int64_t at = 1791900300000LL;
  char out[32];
  missed_when(out, sizeof out, at, at + 60000, 0);
  CHECK_STR(out, "14:05");
  missed_when(out, sizeof out, at, at + 24LL * 3600000, 0);
  CHECK_STR(out, "YESTERDAY 14:05");
  missed_when(out, sizeof out, at, at + 3LL * 24 * 3600000, 0);
  CHECK_STR(out, "13 OCT 14:05");
  missed_when(out, sizeof out, at, at + 60000, 120);  // UTC+2
  CHECK_STR(out, "16:05");
  missed_when(out, sizeof out, at, at + 9LL * 3600000, 120);  // 23:05 UTC: the next day there
  CHECK_STR(out, "YESTERDAY 16:05");
  missed_count_line(out, sizeof out, false, 1, "14:05");
  CHECK_STR(out, "14:05");
  missed_count_line(out, sizeof out, false, 3, "14:05");
  CHECK_STR(out, "3 CALLS 14:05");
  missed_count_line(out, sizeof out, true, 1, "14:05");
  CHECK_STR(out, "CALLED BACK 14:05");
  missed_count_line(out, sizeof out, false, 2, "");  // the clock isn't set yet
  CHECK_STR(out, "2 CALLS");
}

TEST(calls_last_dial_round_trips) {
  last_dial_t d = {.kind = DIAL_KEY, .index = 3}, back;
  char s[80];
  last_dial_encode(&d, s, sizeof s);
  CHECK_STR(s, "k:3");
  CHECK(last_dial_decode(s, &back) && back.kind == DIAL_KEY && back.index == 3);
  CHECK(last_dial_decode("e:204", &back) && back.kind == DIAL_EXT);
  CHECK_STR(back.text, "204");
  CHECK(last_dial_decode("b:mc_xyz", &back) && back.kind == DIAL_BACK);
  CHECK_STR(back.text, "mc_xyz");
  CHECK(last_dial_decode("k:99", &back) && back.index == 99);  // page 10, key 0
  CHECK(!last_dial_decode("k:100", &back) && back.kind == DIAL_NONE);
  CHECK(!last_dial_decode("e:2a", &back));
  CHECK(!last_dial_decode("x:1", &back));
  CHECK(!last_dial_decode("", &back));
  CHECK(!last_dial_decode(NULL, &back));
}
