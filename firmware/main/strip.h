// A C mirror of `statusLines` (apps/device-web/src/strip.ts): ≤ 2 uppercase lines × 16 chars.
#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "phone.h"

#define STATUS_WIDTH 16
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
  char owner_mode[10];        // "kids" | "personal" | "lounge" | ""
  char owner_space[65];
  char owner_person[25];
} phone_config_t;

typedef struct {
  conn_t connection;
  const char *pairing_code;   // NULL unless showing a code
  bool no_wifi;               // no credentials at all: "SET ME UP"
  const phone_state_t *state;
  const phone_config_t *config;
  const char *active_label;   // the other party on the current or last call
  int64_t call_started_ms;    // -1 = not connected yet
  int64_t now_ms;
} strip_input_t;

/** Returns the number of lines (1 or 2) written to out. */
int strip_lines(const strip_input_t *in, char out[2][STATUS_WIDTH + 1]);
