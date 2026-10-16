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
static sidetone_t s_sidetone = SIDETONE_NORMAL;
void audio_set_sidetone(sidetone_t level) { s_sidetone = level; }
sidetone_t audio_sidetone(void) { return s_sidetone; }
static bool s_echo;
void audio_set_echo_cancel(bool on) { s_echo = on; }
bool audio_echo_cancel(void) { return s_echo; }
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
// The network in use: Wi-Fi (rev A) unless a test puts the phone on a cable (hw v0.901).
static net_uplink_t s_net_uplink = NET_WIFI;
static const char *s_cable_line;  // NULL: no wired network on this board
bool net_wifi_up(void) { return s_net_uplink == NET_WIFI; }
net_uplink_t net_uplink(void) { return s_net_uplink; }
const char *net_cable_line(void) { return s_cable_line; }
void net_uplink_ip(char *ip, size_t n) {
  snprintf(ip, n, "%s", s_net_uplink == NET_WIRED ? "192.168.1.23" : "10.0.0.2");
}
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

TEST(menu_root_packs_missed_and_redial_into_five_lines) {
  menu_t m = {0};
  m.calls = true;
  m.extensions = true;
  menu_key(&m, K_MENU, 0);
  char out[MENU_LINES][25];
  int n = menu_lines(&m, out);
  CHECK(n == 6);
  CHECK_STR(out[0], "MENU");
  CHECK_STR(out[1], "1 VOLUME 2 VOICEMAIL");
  CHECK_STR(out[2], "3 NETWORK 5 MISSED");
  CHECK_STR(out[3], "6 EXT 7 CHECK");
  CHECK_STR(out[4], "8 REDIAL 0 ABOUT");
  CHECK_STR(out[5], "9 UPDATE");
  for (int i = 0; i < n; i++) CHECK(strlen(out[i]) <= 20);
  // A Lounge phone in use: 5 and 8 are chat and log out.
  menu_t l = {0};
  l.lounge = l.lounge_session = true;
  menu_key(&l, K_MENU, 0);
  n = menu_lines(&l, out);
  CHECK_STR(out[1], "1 VOLUME 5 CHAT");
  CHECK_STR(out[2], "8 LOG OUT 3 NETWORK");
  reset_events();
  menu_key(&l, key(8), 1);
  CHECK(s_ev_type == EV_LOUNGE_LEAVE);
  // Redial elsewhere.
  reset_events();
  menu_key(&m, key(8), 2);
  CHECK(s_ev_type == EV_REDIAL && m.screen == MENU_CLOSED);
}

TEST(menu_missed_calls_one_at_a_time) {
  menu_t m = {0};
  m.calls = true;
  m.missed_n = 2;
  snprintf(m.missed_from[0], 25, "Mom");
  snprintf(m.missed_line[0], 25, "2 CALLS 14:05");
  snprintf(m.missed_id[0], 65, "mc_1");
  snprintf(m.missed_from[1], 25, "Support");
  snprintf(m.missed_line[1], 25, "CALLED BACK 09:12");
  menu_key(&m, K_MENU, 0);
  menu_key(&m, key(5), 1);
  CHECK(m.screen == MENU_MISSED);
  char out[MENU_LINES][25];
  int n = menu_lines(&m, out);
  CHECK(n == 5);
  CHECK_STR(out[0], "MISSED 1 OF 2");
  CHECK_STR(out[1], "MOM");
  CHECK_STR(out[2], "2 CALLS 14:05");
  CHECK_STR(out[3], "1 CALL BACK 2 NEXT");
  CHECK_STR(out[4], "3 CLEAR ALL");
  menu_key(&m, key(2), 2);
  menu_lines(&m, out);
  CHECK_STR(out[0], "MISSED 2 OF 2");
  CHECK_STR(out[3], "2 NEXT");  // no id: called back from the app
  reset_events();
  menu_key(&m, key(1), 3);
  CHECK(s_ev_type == -1 && m.screen == MENU_MISSED);
  menu_key(&m, key(2), 4);  // round to the first
  reset_events();
  menu_key(&m, key(1), 5);
  CHECK(s_ev_type == EV_CALL_BACK && m.screen == MENU_CLOSED);
  CHECK_STR(s_ev_data, "mc_1");
  menu_key(&m, K_MENU, 6);
  menu_key(&m, key(5), 7);
  reset_events();
  menu_key(&m, key(3), 8);
  CHECK(s_ev_type == EV_MISSED_CLEAR);
  m.missed_n = 0;  // the server cleared them
  n = menu_lines(&m, out);
  CHECK(n == 1);
  CHECK_STR(out[0], "NO MISSED CALLS");
}

TEST(menu_voicemail_clears_messages_only) {
  menu_t m = {0};
  m.can_play = true;
  menu_key(&m, K_MENU, 0);
  menu_key(&m, key(2), 1);
  char out[MENU_LINES][25];
  menu_lines(&m, out);
  CHECK_STR(out[0], "NO NEW VOICEMAIL");
  CHECK_STR(out[1], "1 PLAY");
  reset_events();
  menu_key(&m, key(3), 2);
  CHECK(s_ev_type == -1);  // nothing to clear
  m.voicemail = 2;
  menu_lines(&m, out);
  CHECK_STR(out[1], "1 PLAY 3 CLEAR");
  menu_key(&m, key(3), 3);
  CHECK(s_ev_type == EV_VM_PLAY && s_ev_a == 1);
}

TEST(menu_4_is_the_intercom_or_the_chime) {
  menu_t m = {0};
  m.calls = true;
  m.intercom = true;
  m.n_rooms = 3;
  snprintf(m.rooms[0], 25, "Kitchen");
  snprintf(m.rooms[1], 25, "Den");
  snprintf(m.rooms[2], 25, "Garage");
  snprintf(m.chime, sizeof m.chime, "DINNER'S READY");
  menu_key(&m, K_MENU, 0);
  char out[MENU_LINES][25];
  int n = menu_lines(&m, out);
  CHECK_STR(out[2], "3 NETWORK 4 INTERCOM");
  for (int i = 0; i < n; i++) CHECK(strlen(out[i]) <= 20);
  menu_key(&m, key(4), 1);
  CHECK(m.screen == MENU_INTERCOM);
  n = menu_lines(&m, out);
  CHECK_STR(out[0], "INTERCOM");
  CHECK_STR(out[1], "1 KITCHEN 2 DEN");
  CHECK_STR(out[2], "3 GARAGE");
  CHECK_STR(out[3], "0 ALL 9 CHIME");
  reset_events();
  menu_key(&m, key(2), 2);
  CHECK(s_ev_type == EV_INTERCOM && s_ev_a == 1 && m.screen == MENU_CLOSED);
  menu_key(&m, K_MENU, 3);
  menu_key(&m, key(4), 4);
  reset_events();
  menu_key(&m, key(0), 5);
  CHECK(s_ev_type == EV_INTERCOM && s_ev_a == -1);
  menu_key(&m, K_MENU, 6);
  menu_key(&m, key(4), 7);
  menu_key(&m, key(9), 8);
  CHECK(m.screen == MENU_CHIME);
  n = menu_lines(&m, out);
  CHECK_STR(out[1], "DINNER'S READY");
  CHECK_STR(out[2], "1 SEND TO ALL PHONES");
  reset_events();
  menu_key(&m, key(1), 9);
  CHECK(s_ev_type == EV_CHIME && m.screen == MENU_CLOSED);
  // Without the intercom: 4 is the chime; with neither: the network screen, as before.
  m.intercom = false;
  menu_key(&m, K_MENU, 10);
  menu_lines(&m, out);
  CHECK_STR(out[2], "3 NETWORK 4 CHIME");
  menu_key(&m, key(4), 11);
  CHECK(m.screen == MENU_CHIME);
  m.chime[0] = '\0';
  menu_key(&m, K_MENU, 12);
  menu_key(&m, K_MENU, 13);
  menu_key(&m, key(4), 14);
  CHECK(m.screen == MENU_WIFI);
  // No rooms heard yet.
  menu_t q = {0};
  q.intercom = true;
  menu_key(&q, K_MENU, 0);
  menu_key(&q, key(4), 1);
  CHECK(menu_lines(&q, out) == 2);
  CHECK_STR(out[1], "NO OTHER ROOMS YET");
  reset_events();
  menu_key(&q, key(0), 2);
  CHECK(s_ev_type == -1);
}

TEST(menu_network_screen_on_wifi) {  // rev A, and hw v0.901 without a cable
  s_net_uplink = NET_WIFI;
  s_cable_line = NULL;
  menu_t m = {0};
  menu_key(&m, K_MENU, 0);
  menu_key(&m, key(3), 1);
  char out[MENU_LINES][25];
  CHECK(menu_lines(&m, out) == 4);
  CHECK_STR(out[0], "NETWORK");
  CHECK_STR(out[1], "HOME -50");
  CHECK_STR(out[2], "EXAMPLE.ORG");
  CHECK_STR(out[3], "1 CHANGE");
  // hw v0.901 on Wi-Fi: the cable's state heads the screen, Wi-Fi below.
  s_cable_line = "CABLE UNPLUGGED";
  menu_lines(&m, out);
  CHECK_STR(out[0], "CABLE UNPLUGGED");
  CHECK_STR(out[1], "HOME -50");
  // Neither works.
  s_net_uplink = NET_NONE;
  menu_lines(&m, out);
  CHECK_STR(out[1], "HOME OFFLINE");
  s_net_uplink = NET_WIFI;
  s_cable_line = NULL;
}

TEST(menu_network_screen_on_the_cable) {
  s_net_uplink = NET_WIRED;
  s_cable_line = "WIRED NETWORK";
  menu_t m = {0};
  menu_key(&m, K_MENU, 0);
  menu_key(&m, key(4), 1);  // 4 opens the same screen (the server)
  char out[MENU_LINES][25];
  CHECK(menu_lines(&m, out) == 4);
  CHECK_STR(out[0], "WIRED NETWORK");
  CHECK_STR(out[1], "192.168.1.23");
  CHECK_STR(out[2], "EXAMPLE.ORG");
  CHECK_STR(out[3], "1 CHANGE");
  for (int i = 0; i < 4; i++) CHECK(strlen(out[i]) <= 20);
  reset_events();
  menu_key(&m, key(1), 2);  // setup still opens (the server, and Wi-Fi if wanted)
  CHECK(s_ev_type == EV_PROV_OPEN);
  s_net_uplink = NET_WIFI;
  s_cable_line = NULL;
}

TEST(menu_volume_cycles_the_sidetone) {
  menu_t m = {0};
  char out[MENU_LINES][25];
  menu_key(&m, 10, 0);
  menu_key(&m, 0, 0);  // 1 VOLUME
  CHECK(m.screen == MENU_VOLUME);
  CHECK(menu_lines(&m, out) == 6);
  CHECK_STR(out[4], "6 SIDETONE NORMAL");
  CHECK_STR(out[5], "7 ECHO CANCEL OFF");
  menu_key(&m, 6, 0);  // 7: the echo canceller on
  menu_lines(&m, out);
  CHECK_STR(out[5], "7 ECHO CANCEL ON");
  menu_key(&m, 6, 0);
  CHECK(!audio_echo_cancel());
  menu_key(&m, 5, 0);  // 6: normal → off
  menu_lines(&m, out);
  CHECK_STR(out[4], "6 SIDETONE OFF");
  menu_key(&m, 5, 0);
  menu_lines(&m, out);
  CHECK_STR(out[4], "6 SIDETONE LOW");
  menu_key(&m, 5, 0);
  CHECK(audio_sidetone() == SIDETONE_NORMAL);
}
