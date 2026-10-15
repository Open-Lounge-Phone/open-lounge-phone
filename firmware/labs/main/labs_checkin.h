// Reminders (labs): pills, appointments. Each shows on the screen from its time until a key
// acknowledges it. (The daily check-in itself is the phone's own now: its time is set in the
// app and the server watches it, docs/phone-ux.md "Daily check-in".) Pure: the glue feeds it
// the local day and minute.
#pragma once
#include <stdbool.h>

#include "labs_cfg.h"

typedef struct {
  int acked_day[LABS_REMINDERS];
} checkin_t;

void checkin_init(checkin_t *c);
/** The reminder to show now (-1 = none): its time has come today and it isn't acknowledged. */
int checkin_reminder(const labs_cfg_t *cfg, const checkin_t *c, int day, int minute);
void checkin_ack(checkin_t *c, int reminder, int day);
/** "I'm OK" (a labs check-in key) also acknowledges the reminder showing. */
void checkin_ok(const labs_cfg_t *cfg, checkin_t *c, int day, int minute);
