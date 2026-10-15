// labs/main/labs_checkin.c: the reminders (the daily check-in is the phone's own now).
#include "check.h"
#include "labs_checkin.h"

TEST(labs_reminders) {
  labs_cfg_t cfg;
  labs_cfg_defaults(&cfg);
  checkin_t c;
  checkin_init(&c);
  cfg.n_reminders = 2;
  cfg.reminders[0].at = 540;
  snprintf(cfg.reminders[0].text, sizeof cfg.reminders[0].text, "PILLS");
  cfg.reminders[1].at = 900;
  snprintf(cfg.reminders[1].text, sizeof cfg.reminders[1].text, "DENTIST 4PM");
  CHECK(checkin_reminder(&cfg, &c, 100, 500) == -1);
  CHECK(checkin_reminder(&cfg, &c, 100, 610) == 0);  // the 9:00 one
  checkin_ok(&cfg, &c, 100, 611);                    // I'm OK: the pills are done too
  CHECK(checkin_reminder(&cfg, &c, 100, 612) == -1);
  CHECK(checkin_reminder(&cfg, &c, 100, 905) == 1);
  checkin_ack(&c, 1, 100);
  CHECK(checkin_reminder(&cfg, &c, 100, 906) == -1);
  CHECK(checkin_reminder(&cfg, &c, 101, 545) == 0);  // a new day
  CHECK(checkin_reminder(&cfg, &c, -1, 545) == -1);  // no clock: nothing
}
