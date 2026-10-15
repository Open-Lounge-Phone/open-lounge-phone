// A C mirror of `statusLines` (apps/device-web/src/strip.ts): ≤ 2 uppercase lines; a line
// longer than 16 characters (a long name) scrolls on screen.
#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "phone.h"
#include "vmleave.h"

#define STATUS_WIDTH 16  // what fits a line; longer text (names) scrolls on screen (marquee.c)
#define STATUS_MAX 40    // the longest line kept
#define MAX_BUTTONS 16
#define MAX_MISSED 8

typedef enum { CONN_CONNECTING, CONN_ONLINE, CONN_OFFLINE } conn_t;

typedef struct {
  bool present;               // a config arrived
  char labels[MAX_BUTTONS][25];  // "" = unmapped
  bool quiet;
  char quiet_until[6];        // "HH:MM" or ""
  int missed_count;
  char missed[MAX_MISSED][25];  // newest first
  bool missed_callback[MAX_MISSED];  // …a public line's call back that wasn't taken
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
} strip_input_t;

/** Returns the number of lines (1 or 2) written to out. */
int strip_lines(const strip_input_t *in, char out[2][STATUS_MAX + 1]);
/**
 * An add-on's name with its label, "SEAT - ADD-ON", when that fits on one line (the font has no
 * middle dot); else just the name. `dst` holds at least STATUS_MAX + 1 bytes.
 */
void strip_addon_label(char *dst, const char *name);
/** The trust line: "KIDS: SMITHS", "ANA'S PHONE", "LOUNGE: STUDIO" (≤ STATUS_MAX chars). */
void strip_owner_line(char *dst, const phone_config_t *c);
