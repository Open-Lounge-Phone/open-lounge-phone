// The app task: one queue, one owner of all phone state. Every other module (inputs, network,
// console) only posts events here.
#pragma once

#include <stdbool.h>

#define FW_VERSION "0.1.0"

typedef enum {
  EV_KEY,          // a = key index (0-9 digits in protocol order, 10 MENU, 11 BACK)
  EV_HOOK,         // a = 1 handset up, 0 on the hook
  EV_JACK,         // a = 1 handset plugged in
  EV_WIFI_UP,
  EV_WIFI_DOWN,
  EV_WS_OPEN,
  EV_WS_CLOSED,    // a = close code (0 if none)
  EV_WS_MSG,       // data = malloc'd JSON text (the app frees it)
  EV_DROP,         // console: drop the WebSocket (it reconnects)
  EV_WIPE,         // console: wipe like the server's `wipe`
  EV_RECONNECT,    // console: server changed
} ev_type_t;

typedef struct {
  ev_type_t type;
  int a;
  char *data;
} app_event_t;

/** Post an event to the app task (safe from any task; not from ISRs). */
void app_post(ev_type_t type, int a, char *data);
