#include "labs_checkin.h"

#include <stdio.h>

void checkin_init(checkin_t *c) {
  c->ok_day = c->missed_day = -1;
  for (int i = 0; i < LABS_REMINDERS; i++) c->acked_day[i] = -1;
}

checkin_state_t checkin_state(const labs_cfg_t *cfg, const checkin_t *c, int day, int minute) {
  if (cfg->checkin_by < 0 || day < 0 || minute < 0) return CI_OFF;
  if (c->ok_day == day) return CI_OK;
  if (minute >= cfg->checkin_by) return CI_MISSED;
  return minute >= cfg->checkin_by - 180 ? CI_DUE : CI_WAITING;   // due from 3 hours before
}

bool checkin_due_alert(const labs_cfg_t *cfg, checkin_t *c, int day, int minute) {
  if (checkin_state(cfg, c, day, minute) != CI_MISSED || c->missed_day == day) return false;
  c->missed_day = day;
  return true;
}

int checkin_reminder(const labs_cfg_t *cfg, const checkin_t *c, int day, int minute) {
  int best = -1;
  for (int i = 0; i < cfg->n_reminders; i++)
    if (minute >= cfg->reminders[i].at && c->acked_day[i] != day &&
        (best < 0 || cfg->reminders[i].at < cfg->reminders[best].at))
      best = i;
  return best;
}

void checkin_ack(checkin_t *c, int reminder, int day) {
  if (reminder >= 0 && reminder < LABS_REMINDERS) c->acked_day[reminder] = day;
}

void checkin_ok(const labs_cfg_t *cfg, checkin_t *c, int day, int minute) {
  c->ok_day = day;
  checkin_ack(c, checkin_reminder(cfg, c, day, minute), day);
}

int checkin_lines(const labs_cfg_t *cfg, const checkin_t *c, int day, int minute, char out[2][41]) {
  int r = checkin_reminder(cfg, c, day, minute);
  checkin_state_t st = checkin_state(cfg, c, day, minute);
  if (r >= 0) {
    snprintf(out[0], 41, "%s", cfg->reminders[r].text);
    snprintf(out[1], 41, "PRESS ANY KEY: DONE");
    return 2;
  }
  switch (st) {
    case CI_WAITING:
    case CI_DUE:
      snprintf(out[0], 41, "GOOD MORNING");
      snprintf(out[1], 41, "PRESS 1: I'M OK");
      return 2;
    case CI_MISSED:
      snprintf(out[0], 41, "FAMILY WAS TOLD");
      snprintf(out[1], 41, "PRESS 1: I'M OK");
      return 2;
    case CI_OK:
      snprintf(out[0], 41, "CHECKED IN");
      snprintf(out[1], 41, "SEE YOU TOMORROW");
      return 2;
    default:
      return 0;
  }
}
