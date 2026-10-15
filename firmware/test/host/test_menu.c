// menu.c (docs/phone-ux.md "Menu" and the call screen): which key does what, and what the screen
// says. The rest of the firmware is stubbed: the app's events are recorded.
#include <stdlib.h>

#include "app.h"
#include "audio.h"
#include "check.h"
#include "display.h"
#include "identity.h"
#include "menu.h"
#include "net.h"
#include "ota.h"
#include "signals.h"

// --- stubs ---------------------------------------------------------------------------------
static int s_ev_type = -1, s_ev_a;
static char s_ev_data[32];
void app_post(ev_type_t type, int a, char *data) {
  s_ev_type = (int)type;
  s_ev_a = a;
  snprintf(s_ev_data, sizeof s_ev_data, "%s", data ? data : "");
  free(data);
}
const esp_app_desc_t *esp_app_get_description(void) {
  static const esp_app_desc_t d = {.version = "0.9.4"};
  return &d;
}
static int s_volume = 6;
void audio_set_volume(int level) { s_volume = level; }
int audio_volume(void) { return s_volume; }
int signals_ring_level(void) { return 2; }
void signals_set_ring_level(int level) { (void)level; }
ring_style_t signals_ring_style(void) { return RING_CLASSIC; }
void signals_set_ring_style(ring_style_t style) { (void)style; }
const char *signals_ring_style_name(ring_style_t style) { (void)style; return "CLASSIC"; }
void signals_ring_preview(void) {}
void display_size(int *w, int *h) { *w = 250; *h = 122; }
const char *const *identity_fingerprint(void) {
  static const char *w[] = {"acorn", "bell", "cedar", "duck"};
  return w;
}
void net_wifi_info(char *ssid, size_t ssid_len, int *rssi, char *ip, size_t ip_len) {
  snprintf(ssid, ssid_len, "HOME");
  *rssi = -50;
  snprintf(ip, ip_len, "10.0.0.2");
}
void net_server_url(char *out, size_t len) { snprintf(out, len, "wss://example.org"); }
bool net_wifi_up(void) { return true; }
bool ota_enabled(void) { return true; }

// --- helpers -------------------------------------------------------------------------------
enum { K_MENU = 10, K_BACK = 11 };
/** The key index (protocol order) for digit d. */
static int key(int d) { return d == 0 ? 9 : d - 1; }

static void reset_events(void) {
  s_ev_type = -1;
  s_ev_a = 0;
  s_ev_data[0] = '\0';
}

TEST(menu_call_screen_digits_are_fixed) {
  menu_t m = {0};
  phone_state_t s;
  phone_init(&s);
  s.kind = PH_INCALL;
  s.connected = true;
  m.n_actions = phone_actions(&s, m.actions);
  m.in_call = true;
  CHECK(menu_key(&m, K_MENU, 0));
  CHECK(m.screen == MENU_CALL);
  char out[MENU_LINES][25];
  int n = menu_lines(&m, out);
  CHECK(n == 4);
  CHECK_STR(out[0], "CALL");
  CHECK_STR(out[1], "1 HOLD");
  CHECK_STR(out[2], "2 TRANSFER");
  CHECK_STR(out[3], "3 MUTE 9 VOLUME");
  reset_events();
  menu_key(&m, key(3), 1);
  CHECK(s_ev_type == EV_CALL_ACTION && s_ev_a == ACT_MUTE);
  CHECK(m.screen == MENU_CLOSED);
  // Muted: 3 unmutes.
  s.muted = true;
  m.n_actions = phone_actions(&s, m.actions);
  menu_key(&m, K_MENU, 2);
  n = menu_lines(&m, out);
  CHECK_STR(out[3], "3 UNMUTE 9 VOLUME");
  reset_events();
  menu_key(&m, key(1), 3);
  CHECK(s_ev_type == EV_CALL_ACTION && s_ev_a == ACT_HOLD);
}

TEST(menu_call_screen_in_a_room_mutes_on_3) {
  menu_t m = {0};
  phone_state_t s;
  phone_init(&s);
  s.kind = PH_INROOM;
  snprintf(s.room_id, sizeof s.room_id, "r1");
  m.n_actions = phone_actions(&s, m.actions);
  m.in_call = false;
  menu_key(&m, K_MENU, 0);
  char out[MENU_LINES][25];
  int n = menu_lines(&m, out);
  CHECK(n == 2);
  CHECK_STR(out[0], "ROOM");
  CHECK_STR(out[1], "3 MUTE 9 VOLUME");
  reset_events();
  menu_key(&m, key(1), 1);  // 1 is nothing in a room
  CHECK(s_ev_type == -1 && m.screen == MENU_CALL);
  menu_key(&m, key(3), 2);
  CHECK(s_ev_type == EV_CALL_ACTION && s_ev_a == ACT_MUTE);
}

TEST(menu_call_screen_while_they_hold_you_is_a_call) {
  menu_t m = {0};
  phone_state_t s;
  phone_init(&s);
  s.kind = PH_INCALL;
  s.connected = true;
  s.held_by_them = true;
  m.n_actions = phone_actions(&s, m.actions);
  m.in_call = true;
  menu_key(&m, K_MENU, 0);
  char out[MENU_LINES][25];
  menu_lines(&m, out);
  CHECK_STR(out[0], "CALL");
  CHECK_STR(out[1], "3 MUTE 9 VOLUME");
  menu_key(&m, key(9), 1);
  CHECK(m.screen == MENU_VOLUME);
  menu_key(&m, K_BACK, 2);
  CHECK(m.screen == MENU_CALL);
}
