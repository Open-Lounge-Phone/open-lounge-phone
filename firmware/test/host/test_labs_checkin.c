// labs/main/labs_checkin.c: the daily check-in and reminders.
#include "check.h"
#include "labs_checkin.h"

TEST(checkin_day) {
  labs_cfg_t cfg;
  labs_cfg_defaults(&cfg);
  checkin_t c;
  checkin_init(&c);
  CHECK(checkin_state(&cfg, &c, 100, 480) == CI_OFF);
  cfg.checkin_by = 600;
  cfg.n_reminders = 2;
  cfg.reminders[0].at = 540;
  snprintf(cfg.reminders[0].text, sizeof cfg.reminders[0].text, "PILLS");
  cfg.reminders[1].at = 900;
  snprintf(cfg.reminders[1].text, sizeof cfg.reminders[1].text, "DENTIST 4PM");
  CHECK(checkin_state(&cfg, &c, 100, 300) == CI_WAITING);
  CHECK(checkin_state(&cfg, &c, 100, 480) == CI_DUE);
  CHECK(!checkin_due_alert(&cfg, &c, 100, 599));
  CHECK(checkin_due_alert(&cfg, &c, 100, 600));      // 10:00, nobody pressed: tell the family
  CHECK(!checkin_due_alert(&cfg, &c, 100, 601));     // once a day
  char l[2][41];
  checkin_lines(&cfg, &c, 100, 610, l);
  CHECK_STR(l[0], "PILLS");                          // the 9:00 reminder first
  checkin_ok(&cfg, &c, 100, 611);                    // late, but OK; and the pills are done
  CHECK(checkin_state(&cfg, &c, 100, 612) == CI_OK);
  CHECK(checkin_reminder(&cfg, &c, 100, 612) == -1);
  CHECK(checkin_reminder(&cfg, &c, 100, 905) == 1);
  checkin_ack(&c, 1, 100);
  checkin_lines(&cfg, &c, 100, 906, l);
  CHECK_STR(l[0], "CHECKED IN");
  CHECK(checkin_state(&cfg, &c, 101, 300) == CI_WAITING);   // a new day
  CHECK(checkin_reminder(&cfg, &c, 101, 545) == 0);
}
