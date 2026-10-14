// The daily check-in (labs): one key says "I'm OK"; if nobody presses it by the time set, the
// server tells the family (a check-in alert in their voicemail inbox; their phones show MISSED).
// Reminders (pills, appointments) show on the screen from their time until acknowledged.
// Pure: the glue feeds it the local day and minute.
#pragma once
#include <stdbool.h>

#include "labs_cfg.h"

typedef struct {
  int ok_day;               // the day "I'm OK" was last pressed (-1 = never)
  int missed_day;           // the day the alert was sent (once a day)
  int acked_day[LABS_REMINDERS];
} checkin_t;

typedef enum { CI_OFF, CI_WAITING, CI_DUE, CI_OK, CI_MISSED } checkin_state_t;

void checkin_init(checkin_t *c);
/** Where today stands (day = days since the epoch, minute = local minutes since midnight). */
checkin_state_t checkin_state(const labs_cfg_t *cfg, const checkin_t *c, int day, int minute);
/** The time passed without a check-in today and the alert hasn't gone yet (it may be offline). */
bool checkin_alert_pending(const labs_cfg_t *cfg, const checkin_t *c, int day, int minute);
/** True once, when the time passed without a check-in today: send the alert (marks it sent). */
bool checkin_due_alert(const labs_cfg_t *cfg, checkin_t *c, int day, int minute);
/** "I'm OK" (also acknowledges the reminder showing). */
void checkin_ok(const labs_cfg_t *cfg, checkin_t *c, int day, int minute);
/** The reminder to show now (-1 = none): its time has come today and it isn't acknowledged. */
int checkin_reminder(const labs_cfg_t *cfg, const checkin_t *c, int day, int minute);
void checkin_ack(checkin_t *c, int reminder, int day);
/** Screen lines (≤ 2) for the check-in mode's idle screen. */
int checkin_lines(const labs_cfg_t *cfg, const checkin_t *c, int day, int minute, char out[2][41]);
