// The on-device menu, as docs/phone-ux.md specifies: MENU opens and closes it, a digit picks the
// item shown for it, BACK goes one level up, 20 s without a key closes it.
// Items: 1 Volume (earpiece and ringer), 2 Voicemail, 3 Wi-Fi, 4 Server, 7 Phone check (and the
// self-test), 9 Update now, 0 About. In a call or a room MENU opens the call screen instead: the
// actions (hold / add caller, resume, merge, transfer, mute) from 1, and 9 Volume.
// Planned: 5 / 8 Lounge, 6 Dial extension.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "phone.h"

typedef enum {
  MENU_CLOSED, MENU_ROOT, MENU_ABOUT, MENU_WIFI, MENU_VOLUME, MENU_SERVER, MENU_VOICEMAIL,
  MENU_CALL, MENU_CHECK
} menu_screen_t;

typedef struct {
  menu_screen_t screen;
  int64_t last_input_ms;
  int voicemail;  // new messages (the phone's missed count), shown under 2
  // What the call screen offers now (phone_actions), set by the app before each key and render.
  phone_action_t actions[2];
  int n_actions;
} menu_t;

#define MENU_TIMEOUT_MS 20000

/** Key events: 0-9 digit index (protocol order), 10 MENU, 11 BACK. Returns true if consumed. */
bool menu_key(menu_t *m, int key, int64_t now_ms);
void menu_tick(menu_t *m, int64_t now_ms);
void menu_close(menu_t *m);
/** Lines to show (≤ 4) for the open screen. */
int menu_lines(const menu_t *m, char out[4][25]);
const char *menu_screen_name(menu_screen_t s);
