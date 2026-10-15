#include "labs_checkin.h"

void checkin_init(checkin_t *c) {
  for (int i = 0; i < LABS_REMINDERS; i++) c->acked_day[i] = -1;
}

int checkin_reminder(const labs_cfg_t *cfg, const checkin_t *c, int day, int minute) {
  if (day < 0 || minute < 0) return -1;
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
  checkin_ack(c, checkin_reminder(cfg, c, day, minute), day);
}
