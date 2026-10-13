// lounge.c: what a Lounge phone shows and when it asks for a code (mirrors lounge.ts).
#include "check.h"
#include "lounge.h"

static lounge_t fresh(void) {
  lounge_t l = {.on = true};
  lounge_init(&l);
  return l;
}

TEST(lounge_scan_then_challenge_then_session) {
  lounge_t l = fresh();
  char o[2][41];
  CHECK(lounge_lines(&l, true, false, o, 0) == 2);
  CHECK_STR(o[0], "SCAN TO USE");
  CHECK_STR(o[1], "THIS PHONE");
  CHECK(!lounge_show_qr(&l, true, false, 0));  // no code yet
  CHECK(lounge_wants_refresh(&l, true, false, 0));
  CHECK(!lounge_wants_refresh(&l, true, false, 1000));  // asked just now
  lounge_idle(&l, "nonce-abcdefghijklmnop", 60000);
  CHECK(lounge_show_qr(&l, true, false, 1000));
  CHECK(!lounge_show_qr(&l, true, true, 1000));   // the menu is open
  CHECK(!lounge_show_qr(&l, false, false, 1000)); // handset up
  CHECK(!lounge_wants_refresh(&l, true, false, 10000));
  CHECK(lounge_wants_refresh(&l, true, false, 56000));  // about to expire
  lounge_challenge(&l, 6, 30000);
  lounge_lines(&l, true, false, o, 2000);
  CHECK_STR(o[0], "PRESS KEY 7");
  CHECK(!lounge_show_qr(&l, true, false, 2000));
  lounge_challenge(&l, 9, 30000);
  lounge_lines(&l, true, false, o, 2000);
  CHECK_STR(o[0], "PRESS KEY 0");
  lounge_tick(&l, 30000);  // the proof ran out
  CHECK(l.challenge == -1);
  lounge_session(&l, "Ana", false);
  CHECK(lounge_keys_live(&l));
  lounge_lines(&l, true, false, o, 31000);
  CHECK_STR(o[0], "HI ANA");
  CHECK_STR(o[1], "MENU = OPTIONS");
  CHECK(lounge_lines(&l, false, true, o, 31000) == 0);  // handset up: her key map
  CHECK(!lounge_wants_refresh(&l, true, false, 90000));
}

TEST(lounge_end_forgets_the_person) {
  lounge_t l = fresh();
  char o[2][41];
  lounge_session(&l, "Ana", true);
  lounge_ended(&l, "idle", 1000);
  CHECK(!l.session && !l.name[0] && l.on);
  CHECK(!lounge_keys_live(&l));
  lounge_lines(&l, true, false, o, 2000);
  CHECK_STR(o[0], "SIGNED OUT");
  CHECK_STR(o[1], "TIME'S UP");
  lounge_idle(&l, "nonce-abcdefghijklmnop", 90000);
  CHECK(!lounge_show_qr(&l, true, false, 2000));  // the note first
  lounge_lines(&l, true, false, o, 1000 + LOUNGE_NOTE_MS);
  CHECK_STR(o[0], "SCAN TO USE");
  CHECK(lounge_show_qr(&l, true, false, 1000 + LOUNGE_NOTE_MS));
}

TEST(lounge_house_line_and_here) {
  lounge_t l = fresh();
  char o[2][41];
  l.house_line = true;
  CHECK(lounge_keys_live(&l));
  lounge_lines(&l, true, false, o, 0);
  CHECK_STR(o[1], "OR PRESS A KEY");
  CHECK(lounge_lines(&l, false, true, o, 0) == 0);  // handset up: the house keys
  snprintf(l.here, sizeof l.here, "BEN");
  lounge_lines(&l, true, false, o, 0);
  CHECK_STR(o[1], "HERE: BEN");
  lounge_t off = {0};
  lounge_init(&off);
  CHECK(lounge_lines(&off, true, false, o, 0) == 0);  // not a Lounge phone
  CHECK(lounge_keys_live(&off));
}
