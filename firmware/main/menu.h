// The on-device menu, as docs/phone-ux.md specifies: MENU opens and closes it, a digit picks the
// item shown for it, BACK goes one level up, 20 s without a key closes it.
// Items: 1 Volume (earpiece and ringer), 2 Voicemail, 3 Network (Wi-Fi and server; 4 opens it
// too), 5 Open to chat and 8 Log out (a Lounge phone in use), 6 Dial an extension (team and
// organization spaces), 7 Phone check (and the self-test), 9 Update now, 0 About. In a call or a
// room MENU opens the call screen instead: each action on its digit (1 hold / resume, 2 transfer,
// 3 mute / unmute: phone_action_digit), and 9 Volume.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "phone.h"

typedef enum {
  MENU_CLOSED, MENU_ROOT, MENU_ABOUT, MENU_WIFI, MENU_VOLUME, MENU_SERVER, MENU_VOICEMAIL,
  MENU_CALL, MENU_CHECK, MENU_EXT, MENU_LABS
} menu_screen_t;

/** Who may open the setup network from MENU 3: anyone, after a second press (kids' phones), or
 * nobody (Lounge phones: the space's admin uses MENU+BACK at power-on). */
typedef enum { SETUP_OPEN, SETUP_CONFIRM, SETUP_HIDDEN } setup_guard_t;

typedef struct {
  menu_screen_t screen;
  int64_t last_input_ms;
  int voicemail;  // new messages (senders with unheard voicemail), shown under 2
  int callbacks;  // public lines' call backs that weren't taken; 3 clears them too
  bool can_play;  // a person's own phone: 1 plays the messages, 3 clears them (vmplay.c)
  bool kids;      // a kids' phone: a grown-up listens in the app
  setup_guard_t setup;
  bool confirm;   // MENU 3: 1 was pressed once (SETUP_CONFIRM)
  bool lounge;          // a Lounge phone (shared): no voicemail, no setup from the menu
  bool lounge_session;  // …in use: 5 open to chat, 8 log out
  bool open_to_chat;
  bool extensions;      // the space has extensions: 6 dials one
  char ext[8];          // MENU 6: the digits so far
  bool ext_transfer;    // …to transfer the call there (from the call screen)
  // What the call screen offers now (phone_actions), set by the app before each key and render.
  phone_action_t actions[3];
  int n_actions;
  bool in_call;  // the call screen is for a call (not a room): its title says CALL
} menu_t;

#define MENU_TIMEOUT_MS 20000
/** Lines a menu screen may use (display.h SCREEN_LINES). */
#define MENU_LINES 6

/** Key events: 0-9 digit index (protocol order), 10 MENU, 11 BACK. Returns true if consumed. */
bool menu_key(menu_t *m, int key, int64_t now_ms);
void menu_tick(menu_t *m, int64_t now_ms);
void menu_close(menu_t *m);
/** Lines to show (≤ 4) for the open screen. */
int menu_lines(const menu_t *m, char out[MENU_LINES][25]);
const char *menu_screen_name(menu_screen_t s);
