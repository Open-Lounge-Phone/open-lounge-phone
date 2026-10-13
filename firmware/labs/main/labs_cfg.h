// Labs settings (firmware/labs, 0.0.0): what each digit key does and the features' settings,
// as JSON (the phone's settings page edits it; NVS keeps it). Pure: host-tested.
#pragma once
#include <stdbool.h>
#include <stddef.h>

#define LABS_KEYS 10          // the digit keys, protocol order: 1-9 -> 0-8, 0 -> 9
#define LABS_REMINDERS 6

typedef enum {
  LA_PHONE,     // the normal speed-dial key (the server's key map)
  LA_INTERCOM,  // call a room on this Wi-Fi (target = room name)
  LA_ALL,       // ring every room; the first to lift answers
  LA_CHIME,     // a chime on every phone ("dinner's ready"; target = the words shown)
  LA_HA,        // Home Assistant: call a service (service = "scene.turn_on", target = entity)
  LA_STORY,     // play a WAV from a URL in the handset (url)
  LA_MACRO,     // USB keyboard: a key combo (target = "ctrl+shift+m")
  LA_CHECKIN,   // "I'm OK" (and acknowledges the reminder showing)
  LA_DOORBELL,  // ring the house (or target room); talk back through the handset
  LA_COUNT
} labs_action_t;

typedef enum { LM_PHONE, LM_INTERCOM, LM_CHECKIN, LM_MACRO, LM_HOME, LM_DOORBELL, LM_COUNT } labs_mode_t;

typedef struct {
  labs_action_t action;
  char label[25];      // on the key map ("" = from the action)
  char target[64];
  char service[48];
  char url[192];
} labs_key_t;

typedef struct {
  char name[25];                 // this phone's room ("KITCHEN")
  labs_mode_t mode;              // what the idle screen is about
  labs_key_t keys[LABS_KEYS];
  char ha_url[128];              // http://homeassistant.local:8123
  char ha_token[256];            // long-lived access token (never sent back to the page)
  char ha_status[64];            // an entity whose state is the status line ("cover.garage_door")
  char ha_status_label[25];      // how to say it ("GARAGE")
  int checkin_by;                // minutes since midnight, -1 = no check-in
  struct { int at; char text[25]; } reminders[LABS_REMINDERS];
  int n_reminders;
  char door_label[25];           // what the doorbell says on the house phones ("FRONT DOOR")
} labs_cfg_t;

void labs_cfg_defaults(labs_cfg_t *c);
/** Fills `out` from JSON (missing fields keep their defaults; a blank ha_token keeps `keep`'s). */
bool labs_cfg_parse(const char *json, const labs_cfg_t *keep, labs_cfg_t *out, char *err, size_t errlen);
/** JSON (malloc'd). Without secrets the token is left out (ha_token_set says whether there is one). */
char *labs_cfg_json(const labs_cfg_t *c, bool secrets);
const char *labs_action_name(labs_action_t a);
const char *labs_mode_name(labs_mode_t m);
/** "10:00" -> 600; -1 if not a time. */
int labs_parse_hhmm(const char *s);
/** The label a key shows: its own, or one from the action and target. */
void labs_key_label(const labs_key_t *k, int index, char *out, size_t n);
