// The app task: one queue, one owner of all phone state. Every other module (inputs, network,
// console) only posts events here.
#pragma once

#include <stdbool.h>

// The firmware version is PROJECT_VER in firmware/CMakeLists.txt (the app descriptor, which OTA
// compares too).
#include "esp_app_desc.h"
#define FW_VERSION (esp_app_get_description()->version)

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
  EV_RTC_SDP,      // data = our local SDP (malloc'd): send it as the offer or the answer
  EV_RTC_STATE,    // a = 1 media connected, 2 disconnected, 3 failed to connect
  EV_PROV_OPEN,    // console / MENU: open the Wi-Fi setup network
  EV_PROV_SAVED,   // the setup page saved new Wi-Fi: restart
} ev_type_t;

typedef struct {
  ev_type_t type;
  int a;
  char *data;
} app_event_t;

/** Post an event to the app task (safe from any task; not from ISRs). */
void app_post(ev_type_t type, int a, char *data);
