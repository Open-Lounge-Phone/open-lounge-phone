// Notices (docs/notices.md): a short message from the space ("BUS IS HERE") the phone shows on
// its ready screen with a chime until a key dismisses it or the server clears it. Lifting the
// handset plays its recording. Pure (host-tested): main.c sends, beeps and plays.
#pragma once
#include <stdbool.h>
#include "cJSON.h"

typedef struct {
  bool active;
  char id[65];
  char lines[2][17];
  int n;               // lines: 1 or 2
  char token[129];     // the recording's play token ("" = none)
  int duration_ms;
} notice_t;

void notice_init(notice_t *n);
/** A `notice` message. True when it's a new notice (chime), false for its recording arriving. */
bool notice_set(notice_t *n, const cJSON *msg);
/** A `notice.cleared` message (only for the notice shown). */
void notice_clear(notice_t *n, const char *id);
/** The ready screen's lines while a notice shows (0 = none). */
int notice_lines(const notice_t *n, char out[2][41]);
/** Its recording's path on the server (`/api/notices/<id>/audio?token=`), or false. */
bool notice_audio_path(const notice_t *n, char *out, int size);
