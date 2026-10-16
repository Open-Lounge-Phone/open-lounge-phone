// A C mirror of `statusLines` (apps/device-web/src/strip.ts): ≤ 2 uppercase lines; a line
// longer than 16 characters (a long name) scrolls on screen.
#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "phone.h"
#include "vmleave.h"

#define STATUS_WIDTH 16  // what fits a line; longer text (names) scrolls on screen (marquee.c)
#define STATUS_MAX 40    // the longest line kept
#define KEYS_PER_PAGE 10  // speed-dial keys a page: one per digit key
#define MAX_KEY_PAGES 10  // pages a phone can have (protocol MAX_KEY_PAGES)
#define MAX_BUTTONS (KEYS_PER_PAGE * MAX_KEY_PAGES)  // keys as stored: (page - 1) * 10 + slot
#define MAX_MISSED 8

typedef enum { CONN_CONNECTING, CONN_ONLINE, CONN_OFFLINE } conn_t;

typedef struct {
  bool present;               // a config arrived
  char labels[MAX_BUTTONS][25];  // by stored index ((page - 1) * 10 + slot); "" = unmapped
  bool quiet;
  char quiet_until[6];        // "HH:MM" or ""
  int missed_count;
  char missed[MAX_MISSED][25];  // newest first
  bool missed_callback[MAX_MISSED];  // …a public line's call back that wasn't taken
  bool missed_call[MAX_MISSED];      // …a call that rang, nobody answered, no message (MENU 5)
  int missed_n[MAX_MISSED];          // …how many (calls or messages)
  int64_t missed_at[MAX_MISSED];     // …when the newest was (ms since the epoch, 0 = unknown)
  char missed_id[MAX_MISSED][65];    // …what MENU 5 → 1 calls back ("" = can't from here)
  // The daily check-in (config.checkin): by this time, done today, the guardians were told.
  char checkin_by[6];                // "" = no check-in
  bool checkin_done, checkin_alerted;
  char owner_mode[10];        // "kids" | "personal" | "lounge" | ""
  char owner_space[65];
  char owner_person[25];
} phone_config_t;

typedef struct {
  conn_t connection;
  const char *pairing_code;   // NULL unless showing a code
  bool no_wifi;               // no credentials at all: "NO WI-FI"
  const char *wifi_problem;   // why Wi-Fi won't join (net_wifi_problem), or NULL
  const phone_state_t *state;
  const phone_config_t *config;
  const char *active_label;   // the other party on the current or last call
  int64_t call_started_ms;    // -1 = not connected yet
  bool reconnecting;          // the call's audio connection dropped and may come back
  int64_t now_ms;
  vm_stage_t vm_stage;        // leaving a voicemail (vmleave.c)
  int vm_remaining_ms;        // …while recording
  int local_minute;           // minutes since local midnight for the ready clock, -1 = unknown
  bool checked_in;            // I'm OK was just counted: THANK YOU / CHECKED IN
} strip_input_t;

/** Returns the number of lines (1 or 2) written to out. */
int strip_lines(const strip_input_t *in, char out[2][STATUS_MAX + 1]);
/**
 * The speed-dial pages the phone shows, in order (core `shownPages`): page 1 always, then each
 * later page with keys. Returns how many (1..MAX_KEY_PAGES).
 */
int strip_key_pages(const phone_config_t *c, int out[MAX_KEY_PAGES]);
/**
 * An add-on's name, always marked as one: "SEAT - ADD-ON" (the font has no middle dot), the name
 * shortened when it must be ("THINKIN - ADD-ON"). `dst` holds at least STATUS_MAX + 1 bytes.
 */
void strip_addon_label(char *dst, const char *name);
/** The trust line: "KIDS: SMITHS", "ANA'S PHONE", "LOUNGE: STUDIO" (≤ STATUS_MAX chars). */
void strip_owner_line(char *dst, const phone_config_t *c);
