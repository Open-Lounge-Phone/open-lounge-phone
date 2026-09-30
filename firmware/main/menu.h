// The on-device menu (a subset of apps/device-web/src/menu.ts): MENU opens it, a digit picks
// the item shown for it, BACK steps out, 20 s without a key closes it.
// Items: 1 Volume (1 quieter, 2 louder), 3 Wi-Fi status, 0 About (firmware version + the four
// fingerprint words). TODO: Voicemail, Brightness, call actions (hold/merge/transfer), Dial extension.
#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef enum { MENU_CLOSED, MENU_ROOT, MENU_ABOUT, MENU_WIFI, MENU_VOLUME } menu_screen_t;

typedef struct {
  menu_screen_t screen;
  int64_t last_input_ms;
} menu_t;

#define MENU_TIMEOUT_MS 20000

/** Key events: 0-9 digit index (protocol order), 10 MENU, 11 BACK. Returns true if consumed. */
bool menu_key(menu_t *m, int key, int64_t now_ms);
void menu_tick(menu_t *m, int64_t now_ms);
void menu_close(menu_t *m);
/** Lines to show (≤ 4) for the open screen. */
int menu_lines(const menu_t *m, char out[4][25]);
const char *menu_screen_name(menu_screen_t s);
