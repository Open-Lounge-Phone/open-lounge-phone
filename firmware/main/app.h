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
  EV_OTA_NOW,      // MENU -> 9 / console: check and install an update now
  EV_OTA_DONE,     // a = -1 failed/refused, 0 up to date, 1 available, 2 installed (restart when idle)
  EV_CALL_ACTION,  // MENU in a call: a = phone_action_t
  EV_SELFTEST,     // MENU -> 7 -> 1: start the self-test
  EV_VM_SENT,      // a = 1 the voicemail upload worked
  EV_VM_PLAY,      // MENU -> 2: a = 0 play the messages, 1 clear them (mark heard)
  EV_VM_LOADED,    // a = 1 a message's audio downloaded
  EV_EXT_DIAL,     // MENU -> 6: data = the extension's digits (malloc'd)
  EV_LOUNGE_CHAT,  // MENU -> 5 on a Lounge phone: a = 1 open to chat
  EV_LOUNGE_LEAVE, // MENU -> 8 on a Lounge phone: log out
  EV_LABS,         // labs build: from the intercom / Home Assistant tasks (data, see labs.h)
  EV_CALL_BACK,    // MENU -> 5 -> 1: data = the missed call's id (malloc'd)
  EV_MISSED_CLEAR, // MENU -> 5 -> 3: clear the missed calls (everywhere)
  EV_REDIAL,       // MENU -> 8: call again what this phone last called
  EV_LAN,          // the house intercom's receive task: data = "<ip>|<sealed line>" (malloc'd)
  EV_INTERCOM,     // MENU -> 4 -> a digit: a = the room's index, -1 = every room
  EV_CHIME,        // MENU -> 4: post the chime (a notice to every phone of the space)
} ev_type_t;

typedef struct {
  ev_type_t type;
  int a;
  char *data;
} app_event_t;

/** Post an event to the app task (safe from any task; not from ISRs). */
void app_post(ev_type_t type, int a, char *data);
