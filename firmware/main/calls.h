// Missed calls and redial on the phone (docs/phone-ux.md "Missed calls", MENU 8). Pure (no
// ESP-IDF): host-tested, mirroring packages/core missed.ts and dialOf / redialInput.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** What this phone last called, for MENU 8 Redial (kept in NVS). */
typedef enum { DIAL_NONE, DIAL_KEY, DIAL_EXT, DIAL_BACK } dial_kind_t;
typedef struct {
  dial_kind_t kind;
  int index;       // DIAL_KEY: the key (protocol order)
  char text[65];   // DIAL_EXT: the extension's digits; DIAL_BACK: the missed call's id
} last_dial_t;

/** "k:3", "e:204", "b:mc_xyz" (what NVS keeps). */
void last_dial_encode(const last_dial_t *d, char *out, size_t n);
/** False (and DIAL_NONE) for anything else. */
bool last_dial_decode(const char *s, last_dial_t *d);

/**
 * When a missed call was, for a 20-character line (core `missedWhen`): `14:05` today,
 * `YESTERDAY 09:12`, else `12 OCT 18:30`; `offset_min` is the space's UTC offset.
 */
void missed_when(char *out, size_t n, int64_t at_ms, int64_t now_ms, int offset_min);
/** How many and when (core `missedCountLine`): `2 CALLS 14:05`, `CALLED BACK 09:12`, `14:05`. */
void missed_count_line(char *out, size_t n, bool callback, int count, const char *when);
