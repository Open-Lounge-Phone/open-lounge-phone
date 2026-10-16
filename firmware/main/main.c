// Open Lounge Phone firmware v0: the app task. It owns all phone state; inputs, the network and
// the console only post events to it. Mirrors apps/device-web/src/main.ts (the browser phone):
// hello → (unpaired) pair.begin → pair.code … pair.done → reconnect → auth.challenge →
// auth.proof → config, then the handset state machine (phone.c = deviceStep).
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app.h"
#include "board.h"
#include "cJSON.h"
#include "agc.h"
#include "audio.h"
#include "display.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "identity.h"
#include "input.h"
#include "menu.h"
#include "net.h"
#include "eth.h"
#include "nvs_flash.h"
#include "ota.h"
#include "ota_core.h"
#include "phone.h"
#include "compat.h"
#include "proto.h"
#include "prov.h"
#include "prov_core.h"
#include "media.h"
#include "signals.h"
#include "storage.h"
#include "screens.h"
#include "selftest.h"
#include "strip.h"
#include "vmleave.h"
#include "vmplay.h"
#include "marquee.h"
#include "lounge.h"
#include "notice.h"
#include "calls.h"
#include "lan.h"
#include "nvs.h"
#if CONFIG_OLP_LABS
#include "labs.h"   // the labs build (firmware/labs) only
#endif
#include <sys/time.h>
#include <time.h>

static const char *TAG = "olp";

void console_start(void);

#define PING_MS 25000
#define STATUS_MS 60000
#define PAIRING_TTL_MS (10 * 60 * 1000)  // packages/db PAIRING_TTL_MS
#define PAIR_REFRESH_MS (PAIRING_TTL_MS - 30000)
#define CLOSE_UNAUTHORIZED 4401
#define PHONE_KIND "kids"  // first-run choice (pair.begin.kind); TODO: ask on first run

static QueueHandle_t s_queue;

// --- state (owned by the app task) ---------------------------------------------------------
static conn_t s_conn = CONN_CONNECTING;
static bool s_ws_open, s_authed, s_hook_up;
static char s_code[7];  // pairing code while unpaired
static int64_t s_code_at, s_reopen_at = -1, s_last_ping, s_last_status;
static int s_unauthorized;
static phone_state_t s_phone;
static phone_config_t s_cfg;
static notice_t s_notice;  // a notice from the space on the ready screen (docs/notices.md)
static lounge_t s_lounge;      // a Lounge phone's takeover state (lounge.c)
static bool s_extensions;      // config.extensions: MENU 6 dials one
static bool s_lounge_qr_px;    // the takeover code owns the screen
static char s_lounge_qr_shown[65];
static menu_t s_menu;
static char s_active_label[25];
static int64_t s_call_started = -1;
static char s_shown[SCREEN_LINES][25];
static int s_shown_n = -1;
static int64_t s_boot_until;  // the boot logo stays this long
static bool s_setup_qr;       // the setup QR screen is up
static bool s_about_px;       // MENU → 0 drawn as a page
static bool s_keys_px;        // handset up: who is on which key
static char s_keys_sig[400];  // …what it shows, to redraw only on a change
static bool s_check_px;       // MENU → 7 drawn as a page
static int64_t s_check_drawn;  // …redrawn every few seconds while open
static bool s_selftest_px;    // the self-test owns the screen
static bool s_jack_in;
static int64_t s_conn_since;  // when s_conn last changed (the check page)
static conn_t s_conn_seen = CONN_CONNECTING;
static phone_kind_t s_logged_kind = PH_IDLE;
static prov_t s_prov;  // the Wi-Fi setup network (prov_core.c decides)
// Updates: when to check, whether one is installed and waiting for the phone to be idle, and a
// short message after MENU -> 9.
static int64_t s_next_ota_check = -1, s_idle_since = -1, s_ota_msg_until;
static bool s_ota_restart, s_ota_manual;
static char s_ota_msg[2][25];
#define OTA_CHECK_EVERY_MS (6LL * 60 * 60 * 1000)
// The server can't talk to this phone (protocol versions): what to show, and retry rarely.
static compat_t s_compat = COMPAT_OK;
#define COMPAT_RETRY_MS (60LL * 60 * 1000)
static bool s_rtc_offerer;  // this phone placed the call: it sends the offer
// The call's audio connection dropped (esp_peer DISCONNECTED after CONNECTED): since when, or -1.
// RECONNECTING is shown meanwhile; after RECONNECT_GIVE_UP_MS the call ends as lost.
static int64_t s_reconnect_since = -1;
#define RECONNECT_GIVE_UP_MS 15000
// The other side hanging up drops the connection a moment before the server says the call ended:
// RECONNECTING shows only after this long, so a normal end never looks like a failure.
#define RECONNECT_SHOW_MS 2000
static phone_ends_t s_ends;  // calls that ended here: a repeated ended is dropped
static int s_utc_offset_min;  // the space's (config.utcOffsetMin), for when missed calls were
// The daily check-in: I'm OK was sent and the server hasn't confirmed yet; then THANK YOU until.
static bool s_checkin_sent;
static int64_t s_checked_in_until;
static char s_chime[41];  // config.chime: this phone may post a chime ("" = no)

/** Epoch ms now, or 0 if the clock isn't set. */
static int64_t epoch_now(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  int64_t ms = (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
  return ms > 1700000000000LL ? ms : 0;
}

// MENU 8 Redial: what this phone last called, kept in NVS ("olp" / "last_dial").
static void save_last_dial(const last_dial_t *d) {
  if (s_lounge.on) return;  // a Lounge phone forgets people
  char v[80];
  last_dial_encode(d, v, sizeof v);
  nvs_handle_t h;
  if (nvs_open("olp", NVS_READWRITE, &h) != ESP_OK) return;
  nvs_set_str(h, "last_dial", v);
  nvs_commit(h);
  nvs_close(h);
}

static bool load_last_dial(last_dial_t *d) {
  char v[80] = "";
  size_t len = sizeof v;
  nvs_handle_t h;
  if (nvs_open("olp", NVS_READONLY, &h) == ESP_OK) {
    if (nvs_get_str(h, "last_dial", v, &len) != ESP_OK) v[0] = '\0';
    nvs_close(h);
  }
  return last_dial_decode(v, d);
}
static char *s_local_sdp;  // our SDP from esp_peer, until the call is connecting (then sent)

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

void app_post(ev_type_t type, int a, char *data) {
  app_event_t ev = {.type = type, .a = a, .data = data};
  if (xQueueSend(s_queue, &ev, pdMS_TO_TICKS(100)) != pdTRUE) {
    ESP_LOGW(TAG, "event queue full: dropped event %d", type);
    free(data);
  }
}

static void socket_url(char *out, size_t len) {
  char base[128];
  net_server_url(base, sizeof base);
  size_t n = strlen(base);
  while (n > 0 && base[n - 1] == '/') base[--n] = '\0';
  const char *id = identity_device_id();
  // The device id routes the socket to its household (a Durable Object on Cloudflare).
  if (id[0]) snprintf(out, len, "%s/ws/device?device=%s", base, id);
  else snprintf(out, len, "%s/ws/device", base);
}

/** No server chosen yet (a fresh phone): it connects to nothing until one is. */
static bool s_no_server;

static void open_socket(void) {
  char base[PROV_SERVER_MAX];
  net_server_url(base, sizeof base);
  s_ws_open = s_authed = false;
  s_conn = CONN_CONNECTING;
  s_code[0] = '\0';
  s_no_server = base[0] == '\0';
  if (s_no_server) {
    net_ws_close();
    ESP_LOGI(TAG, "NO SERVER: not connecting (choose one on the setup page, MENU 4 or `server`)");
    return;
  }
  char url[200];
  socket_url(url, sizeof url);
  net_ws_open(url);
}

static cJSON *msg(const char *t) {
  cJSON *m = cJSON_CreateObject();
  cJSON_AddStringToObject(m, "t", t);
  return m;
}

/** Messages from the handset state machine go out only on an authenticated connection. */
static void emit(cJSON *m) {
  if (s_authed) {
    proto_send(m);
    return;
  }
  char *text = cJSON_PrintUnformatted(m);
  ESP_LOGI(TAG, "not signed in: dropped %s", text ? text : "?");
  free(text);
  cJSON_Delete(m);
}

#if CONFIG_OLP_LABS
/** Labs: a message to the server (check-in). False if it couldn't go (not signed in, offline). */
bool app_emit(cJSON *m) {
  if (!s_authed) {
    emit(m);  // logs and drops it
    return false;
  }
  return proto_send(m);
}
#endif

static void end_call(void) {
  media_stop();
  phone_init(&s_phone);
  if (s_hook_up) s_phone.kind = PH_OFFHOOK;
  s_call_started = -1;
}

// --- call media and tones ----------------------------------------------------------------

/** The earpiece tone for the state (`soundFor` in packages/core/src/device.ts; the ring is the
 * piezo's). */
static tone_t tone_for(const phone_state_t *p) {
  switch (p->kind) {
    case PH_OFFHOOK:
      if (p->held[0]) return TONE_HOLD;  // a call on hold: a soft reminder
      return !p->last_end[0] || !strcmp(p->last_end, "hangup") ? TONE_DIAL : TONE_BUSY;
    case PH_DIALING: return p->queued ? TONE_HOLD : TONE_RINGBACK;  // waiting in a line's queue
    case PH_INCALL: return p->waiting_id[0] ? TONE_WAITING : p->held_by_them ? TONE_HOLD : TONE_NONE;
    default: return TONE_NONE;
  }
}

/** The peer connection belongs to the current call, or it goes. */
static bool media_wanted(void) {
  if (!media_active()) return false;
  const char *id = media_call_id();
  if (s_phone.kind == PH_INCALL) return !strcmp(s_phone.call_id, id);
  if (s_phone.kind == PH_OFFHOOK && s_phone.held[0]) return !strcmp(s_phone.held, id);
  if (s_phone.kind == PH_DIALING) return !s_phone.call_id[0] || !strcmp(s_phone.call_id, id);
  return false;
}

static void send_local_sdp(void) {
  // The offer goes out once the call is connecting (both sides have rtc.config), the answer
  // once there's an offer: both mean the phone is in the call.
  if (!s_local_sdp || s_phone.kind != PH_INCALL || strcmp(s_phone.call_id, media_call_id())) return;
  cJSON *m = msg("rtc.sdp");
  cJSON_AddStringToObject(m, "callId", s_phone.call_id);
  cJSON_AddStringToObject(m, "type", s_rtc_offerer ? "offer" : "answer");
  cJSON_AddStringToObject(m, "sdp", s_local_sdp);
  emit(m);
  free(s_local_sdp);
  s_local_sdp = NULL;
}

static void sync_media(void) {
  if (media_active() && !media_wanted()) {
    media_stop();
    free(s_local_sdp);
    s_local_sdp = NULL;
  }
  send_local_sdp();
  audio_hold(s_phone.kind == PH_OFFHOOK && s_phone.held[0]);
  audio_mute(s_phone.kind == PH_INCALL && s_phone.muted);  // MENU 3: the mic sends silence
  // The phone check with the handset up measures the mic (no dial tone over it meanwhile).
  bool listening = s_menu.screen == MENU_CHECK && s_hook_up && s_phone.kind == PH_OFFHOOK;
  audio_listen(listening);
  audio_set_offhook(s_hook_up);
  // No call tone over a message playing (the handset is up for it) or the self-test's tone.
  bool quiet = selftest_active() || vmplay_active() || listening || lan_busy();
  if (!quiet) audio_set_tone(s_hook_up ? tone_for(&s_phone) : TONE_NONE);
  else if (!selftest_active()) audio_set_tone(TONE_NONE);
}

// --- rendering ---------------------------------------------------------------------------

static void draw_check(int w, int h, int64_t now);

/** The server's web address (wss://host/path → https://host/path) for links on screen. */
static void http_base(char *out, size_t n) {
  char url[PROV_SERVER_MAX];
  net_server_url(url, sizeof url);
  if (!strncmp(url, "wss://", 6)) snprintf(out, n, "https://%s", url + 6);
  else if (!strncmp(url, "ws://", 5)) snprintf(out, n, "http://%s", url + 5);
  else snprintf(out, n, "%s", url);
  size_t l = strlen(out);
  if (l && out[l - 1] == '/') out[l - 1] = '\0';
}

/** Characters per line at the size gfx_render_lines picks for `n` lines. */
static int line_capacity(int w, int h, int n) {
  int scale = n <= 2 ? 3 : 2;
  while (scale > 1 && (16 * 6 * scale > w || n * 10 * scale > h)) scale--;
  int cap = (w - 4) / (6 * scale);
  return cap > 24 ? 24 : cap;
}

static void render(void) {
  int64_t now = now_ms();
  if (s_conn != s_conn_seen) {
    s_conn_seen = s_conn;
    s_conn_since = now;
  }
  if (s_phone.kind != s_logged_kind) {
    ESP_LOGI(TAG, "STATE %s", phone_kind_name(s_phone.kind));
    s_logged_kind = s_phone.kind;
  }
  if (s_phone.kind == PH_INCALL && s_phone.connected) {
    if (s_call_started < 0) s_call_started = now;
  } else {
    s_call_started = -1;
  }

  char lines[SCREEN_LINES][25] = {{0}};
  int n_status = 0;  // lines from the status strip (0 = a menu or another screen has them)
  // MENU 2 counts the messages; MENU 5 lists the missed calls and call backs, newest first.
  s_menu.voicemail = 0;
  s_menu.missed_n = 0;
  int64_t wall = epoch_now();
  for (int i = 0; i < s_cfg.missed_count && i < MAX_MISSED; i++) {
    if (!s_cfg.missed_callback[i] && !s_cfg.missed_call[i]) {
      s_menu.voicemail++;
      continue;
    }
    int k = s_menu.missed_n++;
    char when[24];
    if (wall && s_cfg.missed_at[i]) missed_when(when, sizeof when, s_cfg.missed_at[i], wall, s_utc_offset_min);
    else snprintf(when, sizeof when, "%s", "");
    missed_count_line(s_menu.missed_line[k], sizeof s_menu.missed_line[k], s_cfg.missed_callback[i],
                      s_cfg.missed_n[i], when);
    snprintf(s_menu.missed_from[k], sizeof s_menu.missed_from[k], "%s", s_cfg.missed[i]);
    snprintf(s_menu.missed_id[k], sizeof s_menu.missed_id[k], "%s", s_cfg.missed_id[i]);
  }
  s_menu.calls = !s_lounge.on;
  // MENU 4: the house intercom's rooms, or the chime.
  s_menu.intercom = lan_enabled() && !s_lounge.on;
  s_menu.n_rooms = s_menu.intercom ? lan_rooms(s_menu.rooms, 8, now) : 0;
  snprintf(s_menu.chime, sizeof s_menu.chime, "%s", s_lounge.on ? "" : s_chime);
  s_menu.can_play = !strcmp(s_cfg.owner_mode, "personal");
  s_menu.kids = !s_cfg.owner_mode[0] || !strcmp(s_cfg.owner_mode, "kids");
  s_menu.lounge = s_lounge.on;
  s_menu.lounge_session = s_lounge.session;
  s_menu.open_to_chat = s_lounge.open_to_chat;
  s_menu.extensions = s_extensions;
  s_menu.setup = s_lounge.on ? SETUP_HIDDEN : s_menu.kids ? SETUP_CONFIRM : SETUP_OPEN;
  int n = vmplay_active() ? vmplay_lines(lines, now) : 0;
  if (n == 0) n = menu_lines(&s_menu, lines);
  bool busy = s_phone.kind != PH_IDLE && s_phone.kind != PH_OFFHOOK;
  if (n == 0 && (ota_state() == OTA_DOWNLOADING || ota_state() == OTA_RESTARTING ||
                 (s_ota_manual && ota_state() == OTA_CHECKING))) {
    if (ota_state() == OTA_CHECKING) snprintf(lines[0], 25, "CHECKING UPDATE");
    else if (ota_state() == OTA_DOWNLOADING) snprintf(lines[0], 25, "UPDATING %d%%", ota_progress());
    else snprintf(lines[0], 25, "UPDATED");
    snprintf(lines[1], 25, "%s", ota_state() == OTA_CHECKING ? "PLEASE WAIT" : "DON'T UNPLUG");
    n = 2;
  } else if (n == 0 && now < s_ota_msg_until) {
    memcpy(lines, s_ota_msg, sizeof s_ota_msg);
    n = 2;
  }
  bool qr = false;
  if (n == 0 && prov_ap_active() && !busy) {
    // The steps, while the setup network is open: join it with the password, open the page.
    qr = true;
    snprintf(lines[0], 25, "WI-FI SETUP: JOIN");
    snprintf(lines[1], 25, "%.24s", prov_ssid());
    snprintf(lines[2], 25, "PASSWORD %s", prov_password());
    snprintf(lines[3], 25, "OPEN 192.168.4.1");
    n = 4;
  }
  if (n == 0 && s_compat != COMPAT_OK && !busy) {
    compat_lines(s_compat, lines);
    n = 2;
  }
  bool standalone = false;   // labs: an intercom / doorbell / home panel needs no server
#if CONFIG_OLP_LABS
  standalone = labs_standalone();
#endif
  if (n == 0 && s_no_server && !busy && !standalone) {
    snprintf(lines[0], 25, "SET UP:");
    snprintf(lines[1], 25, "CHOOSE A SERVER");
    snprintf(lines[2], 25, "PRESS MENU 4");
    n = 3;
  }
  char strip[2][STATUS_MAX + 1];
  if (n == 0) {
    strip_input_t in = {
        .connection = s_conn,
        .pairing_code = s_code[0] ? s_code : NULL,
        .no_wifi = false,
        .state = &s_phone,
        .config = &s_cfg,
        .active_label = s_active_label,
        .call_started_ms = s_call_started,
        .reconnecting = s_reconnect_since >= 0 && s_phone.kind == PH_INCALL &&
                        now - s_reconnect_since >= RECONNECT_SHOW_MS,
        .now_ms = now,
        .local_minute = ota_local_minute(),
        .vm_stage = vm_leave_stage(),
        .vm_remaining_ms = vm_leave_remaining_ms(now),
        .checked_in = now < s_checked_in_until,
    };
    char ssid[33], ip[16];
    int rssi;
    net_wifi_info(ssid, sizeof ssid, &rssi, ip, sizeof ip);
    // A board with a working wired network says what its cable is doing instead of NO WI-FI.
    in.no_wifi = ssid[0] == '\0' && !net_wired();
    in.wifi_problem = net_problem();
    n = strip_lines(&in, strip);
    // A Lounge phone: SCAN TO USE, PRESS KEY 7, HI ANA (lounge.c) over the usual status.
    char ll[2][41];
    bool idle = s_phone.kind == PH_IDLE && !s_hook_up;
    int ln = s_authed && s_conn == CONN_ONLINE && !s_code[0]
                 ? lounge_lines(&s_lounge, idle, s_phone.kind == PH_OFFHOOK, ll, now)
                 : 0;
#if CONFIG_OLP_LABS
    if (!ln && net_up() && !s_code[0])
      ln = labs_lines(ll, idle, s_phone.kind == PH_OFFHOOK, now);
#endif
    // The house intercom ringing, calling or talking (or its note) over the rest.
    int lnn = lan_lines(ll, now);
    if (lnn) ln = lnn;
    if (ln) {
      for (int i = 0; i < ln; i++) snprintf(strip[i], sizeof strip[i], "%.40s", ll[i]);
      n = ln;
    }
    // A notice from the space shows on the ready screen until a key dismisses it.
    int nn = idle && s_menu.screen == MENU_CLOSED ? notice_lines(&s_notice, ll) : 0;
    if (nn) {
      for (int i = 0; i < nn; i++) snprintf(strip[i], sizeof strip[i], "%.40s", ll[i]);
      n = nn;
    }
    n_status = n;
  }
  int w, h;
  display_size(&w, &h);
  // Text longer than a line scrolls in a loop (marquee.c) instead of being cut off.
  char full[SCREEN_LINES][STATUS_MAX + 1] = {{0}};
  for (int i = 0; i < n; i++) snprintf(full[i], sizeof full[i], "%.40s", n_status ? strip[i] : lines[i]);
  long step = (long)(now / MARQUEE_STEP_MS);
  for (int i = 0; i < n; i++) marquee(lines[i], sizeof lines[i], full[i], line_capacity(w, h, n), step);
  if (s_boot_until && now >= s_boot_until) {
    s_boot_until = 0;
    display_pixels(NULL);
  }
  if (qr && !s_boot_until && !s_setup_qr) {
    uint8_t *fb = calloc(1, (size_t)(w * h + 7) / 8);
    if (fb) {
      screen_setup(fb, w, h, prov_ssid(), prov_password());
      display_pixels(fb);
      free(fb);
      s_setup_qr = true;
    }
  } else if (!qr && s_setup_qr) {
    s_setup_qr = false;
    display_pixels(NULL);
  }
  bool about = s_menu.screen == MENU_ABOUT;
  if (about && !s_about_px && !s_boot_until) {
    uint8_t *fb = calloc(1, (size_t)(w * h + 7) / 8);
    if (fb) {
      char url[PROV_SERVER_MAX], host[PROV_SERVER_MAX];
      net_server_url(url, sizeof url);
      if (!strcmp(url, PROV_HUB_URL)) snprintf(host, sizeof host, "PUBLIC HUB");
      else if (url[0]) prov_server_host(url, host, sizeof host);
      else host[0] = '\0';
      screen_about(fb, w, h, FW_VERSION, CONFIG_OLP_BOARD_ID, host, identity_fingerprint());
      display_pixels(fb);
      free(fb);
      s_about_px = true;
    }
  } else if (!about && s_about_px) {
    s_about_px = false;
    if (!s_setup_qr) display_pixels(NULL);
  }
  // Handset up, nothing dialled: whose phone this is and who is on each key (docs/phone-ux.md).
  bool keys = n_status > 0 && s_phone.kind == PH_OFFHOOK && !s_phone.held[0] && s_authed &&
              lounge_keys_live(&s_lounge) && s_lounge.challenge < 0 &&
              s_conn == CONN_ONLINE && !s_code[0] && s_menu.screen == MENU_CLOSED &&
              !selftest_active() && !lan_busy();  // the house intercom's screen instead
  if (keys && !s_boot_until) {
    char title[STATUS_MAX + 1] = "SPEED DIAL", footer[96], sig[sizeof s_keys_sig];
    if (s_cfg.owner_mode[0]) strip_owner_line(title, &s_cfg);
    if (n_status == 2) snprintf(footer, sizeof footer, "%s - %s", full[0], full[1]);
    else snprintf(footer, sizeof footer, "PRESS A KEY TO CALL");
    // The page of keys on screen (BACK turns it): its ten labels.
    int page = s_phone.page > 1 ? s_phone.page : 1;
    const char *labels[10];
    for (int i = 0; i < 10; i++) labels[i] = s_cfg.labels[(page - 1) * KEYS_PER_PAGE + i];
#if CONFIG_OLP_LABS
    for (int i = 0; page == 1 && i < 10; i++)
      if (labs_label(i)) labels[i] = labs_label(i);
#endif
    // Long names scroll: then each step is a new picture.
    long kstep = screen_keys_scrolls(w, h, title, labels, footer) ? step : 0;
    int at = snprintf(sig, sizeof sig, "%ld|%s|%s", kstep, title, footer);
    for (int i = 0; i < 10; i++)
      if (at < (int)sizeof sig) at += snprintf(sig + at, sizeof sig - at, "|%s", labels[i]);
    if (!s_keys_px || strcmp(sig, s_keys_sig)) {
      uint8_t *fb = calloc(1, (size_t)(w * h + 7) / 8);
      if (fb) {
        screen_keys(fb, w, h, title, labels, footer, kstep);
        display_pixels(fb);
        free(fb);
        if (!kstep || !s_keys_px) ESP_LOGI(TAG, "KEYS %s", sig);
      }
      snprintf(s_keys_sig, sizeof s_keys_sig, "%s", sig);
      s_keys_px = true;
    }
  } else if (s_keys_px) {
    s_keys_px = false;
    if (!s_setup_qr && !s_about_px) display_pixels(NULL);
  }

  // A free Lounge phone: its takeover code, redrawn when the code (or the hint) changes.
  bool lqr = s_authed && s_conn == CONN_ONLINE && !s_code[0] &&
             lounge_show_qr(&s_lounge, s_phone.kind == PH_IDLE && !s_hook_up,
                            s_menu.screen != MENU_CLOSED, now);
  if (lqr && !s_boot_until && !s_setup_qr) {
    char sig[sizeof s_lounge_qr_shown];
    snprintf(sig, sizeof sig, "%.24s|%.38s", s_lounge.nonce, n_status > 1 ? full[1] : "");
    if (!s_lounge_qr_px || strcmp(sig, s_lounge_qr_shown)) {
      uint8_t *fb = calloc(1, (size_t)(w * h + 7) / 8);
      char url[PROV_SERVER_MAX + 140];
      http_base(url, sizeof url);
      size_t at = strlen(url);
      snprintf(url + at, sizeof url - at, "/lounge#%s.%s", identity_device_id(), s_lounge.nonce);
      if (fb) {
        screen_lounge(fb, w, h, url, s_cfg.owner_space, n_status > 1 ? full[1] : "");
        display_pixels(fb);
        free(fb);
      }
      ESP_LOGI(TAG, "LOUNGE code shown [SCAN TO USE|%s]", n_status > 1 ? full[1] : "");
      snprintf(s_lounge_qr_shown, sizeof s_lounge_qr_shown, "%s", sig);
      s_lounge_qr_px = true;
    }
  } else if (s_lounge_qr_px) {
    s_lounge_qr_px = false;
    if (!s_setup_qr && !s_about_px && !s_keys_px) display_pixels(NULL);
  }

  // MENU → 7: the phone check page, redrawn every 10 s while open (signal, uptime, memory).
  bool check = s_menu.screen == MENU_CHECK;
  // Every 10 s; every second while it shows the mic's live level (the handset is up).
  int64_t every = s_hook_up ? 1000 : 10000;
  if (check && !s_boot_until && (!s_check_px || now - s_check_drawn >= every)) {
    draw_check(w, h, now);
    s_check_px = true;
    s_check_drawn = now;
  } else if (!check && s_check_px) {
    s_check_px = false;
    if (!s_setup_qr && !s_about_px && !selftest_active()) display_pixels(NULL);
  }
  if (selftest_active()) {
    if (selftest_dirty() || !s_selftest_px) {
      uint8_t *fb = calloc(1, (size_t)(w * h + 7) / 8);
      if (fb) {
        selftest_draw(fb, w, h);
        display_pixels(fb);
        free(fb);
      }
      s_selftest_px = true;
    }
  } else if (s_selftest_px) {
    s_selftest_px = false;
    display_pixels(NULL);
  }
  if (s_boot_until || s_setup_qr || s_about_px || s_check_px || s_selftest_px ||
      s_keys_px || s_lounge_qr_px) {
    s_shown_n = -1;  // a pixel screen owns the display; redraw the status after it
  } else if (n != s_shown_n || memcmp(lines, s_shown, sizeof s_shown)) {
    memcpy(s_shown, lines, sizeof s_shown);
    s_shown_n = n;
    static char logged[SCREEN_LINES][STATUS_MAX + 1];  // the log gets the whole text once, not each step
    if (memcmp(full, logged, sizeof logged)) {
      memcpy(logged, full, sizeof logged);
      char joined[SCREEN_LINES * (STATUS_MAX + 1) + 1] = "";
      for (int i = 0; i < n; i++) {
        if (i) strlcat(joined, "|", sizeof joined);
        strlcat(joined, full[i], sizeof joined);
      }
      ESP_LOGI(TAG, "STRIP [%s]", joined);
    }
    const char *ptrs[SCREEN_LINES];
    for (int i = 0; i < SCREEN_LINES; i++) ptrs[i] = lines[i];
    display_text(ptrs, n);
  }

  // The status LED (leds.ts `status`, on a single-colour LED) and the ringer.
  led_pattern_t led;
  if (s_code[0] || s_conn == CONN_CONNECTING) led = LED_PULSE;
  else if (s_conn == CONN_OFFLINE) led = LED_BLINK;
  else if (s_phone.kind == PH_INCOMING || s_lounge.challenge >= 0) led = LED_RINGING;
  else if ((s_phone.kind == PH_INCALL || s_phone.kind == PH_INROOM) && s_phone.recorded)
    led = LED_RECORDING;
  else if ((s_phone.kind == PH_INCALL || s_phone.kind == PH_INROOM) && s_phone.muted)
    led = LED_MUTED;  // MENU 3: a slow double blink
  else if (s_phone.kind == PH_INCALL || s_phone.kind == PH_INROOM || s_phone.kind == PH_DIALING)
    led = LED_ON;
  else if (s_phone.kind == PH_IDLE && s_cfg.missed_count > 0) led = LED_BREATHE;
  else led = LED_DIM;
  // The house intercom: ringing here, or a call on it. (One pattern per pass: setting two
  // restarts the LED's pattern each time.)
  if (lan_ringing()) led = LED_RINGING;
  else if (lan_busy()) led = LED_ON;
  signals_led(led);
  // BACK silences a ringing call here.
  signals_ring((s_phone.kind == PH_INCOMING && !s_phone.silenced) || lan_ringing());
}

/** "2H05" or "14 MIN" for durations on the check page. */
static void span(char *buf, size_t n, int64_t ms) {
  long m = (long)(ms / 60000);
  if (m >= 60) snprintf(buf, n, "%ldH%02ld", m / 60, m % 60);
  else snprintf(buf, n, "%ld MIN", m);
}

static void draw_check(int w, int h, int64_t now) {
  uint8_t *fb = calloc(1, (size_t)(w * h + 7) / 8);
  if (!fb) return;
  char ssid[33], ip[16], url[PROV_SERVER_MAX];
  int rssi;
  net_wifi_info(ssid, sizeof ssid, &rssi, ip, sizeof ip);
  net_server_url(url, sizeof url);
  char wifi[48], server[48], issue[40], handset[32], up[40], mem[40], t[16], mic[40];
  const char *net_label = "WI-FI";
  if (!ssid[0]) snprintf(wifi, sizeof wifi, "NOT SET");
  else if (!net_wifi_up()) snprintf(wifi, sizeof wifi, "%.14s, NOT JOINED", ssid);
  else snprintf(wifi, sizeof wifi, "%.12s %d DBM CH %d", ssid, rssi, net_wifi_channel());
  if (net_uplink() == NET_WIRED) {  // hw v0.901 on its cable: the link instead of Wi-Fi
    eth_info_t e;
    eth_info(&e);
    net_label = "CABLE";
    snprintf(wifi, sizeof wifi, "%d MBIT/S %s DUPLEX", e.speed_mbps, e.full_duplex ? "FULL" : "HALF");
    net_uplink_ip(ip, sizeof ip);
  }
  static const char *conns[] = {"CONNECTING", "ONLINE", "OFFLINE"};
  span(t, sizeof t, now - s_conn_since);
  if (!url[0]) snprintf(server, sizeof server, "NOT SET");
  else snprintf(server, sizeof server, "%s, %s", s_code[0] ? "PAIRING" : conns[s_conn], t);
  int reason;
  const char *why = net_last_wifi_problem(&reason);
  if (why) snprintf(issue, sizeof issue, "%s (%d)", why, reason);
  else snprintf(issue, sizeof issue, "NONE");
  snprintf(handset, sizeof handset, "%s, JACK %s", s_hook_up ? "UP" : "DOWN",
           s_jack_in ? "IN" : "OUT");
  span(t, sizeof t, now);
  int minute = ota_local_minute();
  if (minute >= 0) snprintf(up, sizeof up, "%s, CLOCK %02d:%02d", t, minute / 60, minute % 60);
  else snprintf(up, sizeof up, "%s, CLOCK NOT SET", t);
  snprintf(mem, sizeof mem, "%u KB FREE, LOW %u KB", (unsigned)(esp_get_free_heap_size() / 1024),
           (unsigned)(esp_get_minimum_free_heap_size() / 1024));
  // The handset's mic, live while the handset is up (speak into it): the speech level after the
  // AGC, and a word from the level at the ADC (a weak handset, or too much analog gain).
  audio_stats_t st = audio_stats();
  bool heard = st.speech_ms > 0 && now - st.speech_ms < 3000 && st.speech_in_dbfs > -99;
  if (!s_hook_up) snprintf(mic, sizeof mic, "LIFT TO TEST");
  else if (!heard) snprintf(mic, sizeof mic, "SPEAK NOW");
  else
    snprintf(mic, sizeof mic, "SPEAK NOW: %.0f DB %s",
             audio_agc_on() ? st.speech_out_dbfs : st.speech_in_dbfs,
             agc_verdict(st.speech_in_dbfs, st.mic_peak_dbfs));
  // The echo test (2, handset up): how much of the earpiece comes back in the mic, and how late.
  char echo[40];
  echo_result_t er;
  int ets = audio_echo_test_state(&er);
  if (ets == 1 || ets == 2) snprintf(echo, sizeof echo, "TESTING...");
  else if (ets == 3 && er.heard)
    snprintf(echo, sizeof echo, "%.0f DB %s, %.0f MS", er.erl_db, echo_word(er.erl_db), er.delay_ms);
  else if (ets == 3) snprintf(echo, sizeof echo, "OVER %.0f DB %s", er.erl_db, echo_word(er.erl_db));
  else snprintf(echo, sizeof echo, s_hook_up ? "PRESS 2" : "LIFT, PRESS 2");
  const char *rows[][2] = {
      {net_label, wifi},     {"ADDRESS", ip[0] ? ip : "-"}, {"SERVER", server},
      {"LAST ISSUE", issue}, {"HANDSET", handset},          {"MIC", mic},
      {"ECHO", echo},        {"RUNNING", up},               {"MEMORY", mem},
  };
  screen_page(fb, w, h, "PHONE CHECK", rows, 9, "1 SELF-TEST 2 ECHO  BACK: MENU");
  display_pixels(fb);
  free(fb);
  ESP_LOGI(TAG, "CHECK wifi=[%s] ip=%s server=[%s] issue=[%s] handset=[%s] mic=[%s] up=[%s] mem=[%s] "
           "echo=[%s] miclevel=%.1f micpeak=%.1f speechin=%.1f agc=%.1f",
           wifi, ip[0] ? ip : "-", server, issue, handset, mic, up, mem, echo, st.mic_dbfs,
           st.mic_peak_dbfs, st.speech_in_dbfs, st.agc_gain_db);
}

void app_print_lounge(void) {
  char url[PROV_SERVER_MAX + 140];
  http_base(url, sizeof url);
  size_t at = strlen(url);
  snprintf(url + at, sizeof url - at, "/lounge#%s.%s", identity_device_id(), s_lounge.nonce);
  printf("LOUNGE on=%d session=%d name=%s chat=%d challenge=%d house_line=%d here=%s url=%s\n",
         s_lounge.on, s_lounge.session, s_lounge.name[0] ? s_lounge.name : "-",
         s_lounge.open_to_chat, s_lounge.challenge, s_lounge.house_line,
         s_lounge.here[0] ? s_lounge.here : "-", s_lounge.nonce[0] ? url : "-");
}

void app_print_status(void) {
  char ssid[33], ip[16];
  int rssi;
  net_wifi_info(ssid, sizeof ssid, &rssi, ip, sizeof ip);
  const char *const *w = identity_fingerprint();
  static const char *conns[] = {"connecting", "online", "offline"};
  printf("STATUS state=%s conn=%s authed=%d device=%s code=%s wifi=%s rssi=%d ip=%s "
         "words=%s-%s-%s-%s missed=%d storage=%s strip=%s|%s menu=%s\n",
         phone_kind_name(s_phone.kind), conns[s_conn], s_authed,
         identity_device_id()[0] ? identity_device_id() : "-", s_code[0] ? s_code : "-",
         ssid[0] ? ssid : "-", rssi, ip[0] ? ip : "-", w[0], w[1], w[2], w[3], s_cfg.missed_count,
         storage_encrypted() ? "encrypted" : "plain", s_shown[0], s_shown[1],
         menu_screen_name(s_menu.screen));
#if BOARD_HAS_ETHERNET
  char nip[16];
  net_uplink_ip(nip, sizeof nip);
  const char *cable = net_cable_line();
  static const char *uplinks[] = {"none", "wired", "wifi"};
  printf("NET uplink=%s ip=%s cable=%s\n", uplinks[net_uplink()], nip[0] ? nip : "-",
         cable ? cable : "none");
#endif
}

// --- the network: Wi-Fi, or the cable on hw v0.901 ---------------------------------------------

static bool s_started;      // the server connection was opened once (it reconnects by itself)
#if BOARD_HAS_ETHERNET
static bool s_prov_booted;  // setup was told the power-on network state (after the choice)
#endif
static void prov_event(prov_event_t ev, bool forced);
static void on_closed(int code);

/** Online (Wi-Fi joined, or the cable has an address). */
static void network_up(bool wired) {
  prov_event(wired ? PROV_EV_WIRED_UP : PROV_EV_STA_UP, false);
  lan_net_up();
#if CONFIG_OLP_LABS
  labs_net_up();
#endif
  if (ota_enabled()) ota_time_start();  // the clock is only for the update window
  if (s_next_ota_check < 0) s_next_ota_check = now_ms() + 60 * 1000;  // first check
  if (!s_started) {
    s_started = true;
    open_socket();
  }
}

static void network_down(void) {
  prov_event(PROV_EV_STA_DOWN, false);
  if (!s_ws_open) s_conn = CONN_OFFLINE;
}

#if BOARD_HAS_ETHERNET
/** A call (or a message, or the house intercom) is on: the network choice doesn't move it. */
static bool network_busy(void) {
  return (s_phone.kind != PH_IDLE && s_phone.kind != PH_OFFHOOK) || media_active() ||
         vm_leave_stage() != VM_IDLE || lan_busy();
}

static void network_changed(net_change_t c) {
  switch (c) {
    case NET_WENT_UP:
      network_up(net_uplink() == NET_WIRED);
      break;
    case NET_SWITCHED:
      // The server connection (and a call's media) lived on the other network: start over on this
      // one rather than wait for the old socket to time out. A call on it is over (on_closed).
      ESP_LOGW(TAG, "NET switched to %s: reconnecting to the server",
               net_uplink() == NET_WIRED ? "the cable" : "Wi-Fi");
      {
        bool reopen = s_started;  // else network_up opens it for the first time
        network_up(net_uplink() == NET_WIRED);
        if (reopen) {
          if (s_ws_open) on_closed(0);
          open_socket();
        }
      }
      break;
    case NET_WENT_DOWN:
      network_down();
      break;
    case NET_SAME:
      break;
  }
}
#endif

// --- the Wi-Fi setup network ----------------------------------------------------------------

static void prov_event(prov_event_t ev, bool forced) {
  // A working cable (hw v0.901) is a network too: setup isn't needed for one.
  bool has_network = net_has_wifi() || net_uplink() == NET_WIRED;
  switch (prov_step(&s_prov, ev, has_network, forced, now_ms())) {
    case PROV_ACT_START_AP:
      ESP_LOGI(TAG, "PROV open (%s)",
               ev == PROV_EV_TICK ? (net_wired() ? "no network for 3 min"
                                                 : "saved Wi-Fi unreachable for 3 min")
               : ev == PROV_EV_OPEN ? "asked for"
               : forced             ? "MENU+BACK at power-on"
               : net_wired()        ? "no Wi-Fi saved, no cable"
                                    : "no Wi-Fi saved");
      prov_start_ap();
      break;
    case PROV_ACT_STOP_AP:
      ESP_LOGI(TAG, "PROV close (%s)", ev == PROV_EV_WIRED_UP ? "online over the cable"
                                                                : "back on the saved Wi-Fi");
      prov_stop_ap();
      break;
    case PROV_ACT_REBOOT: {
      const char *lines[] = {"WI-FI SAVED", "RESTARTING"};
      display_text(lines, 2);
      vTaskDelay(pdMS_TO_TICKS(1000));
      esp_restart();
      break;
    }
    case PROV_ACT_NONE:
      break;
  }
}

static void show_hold(int held_ms) {
  static int last = -1;
  int stage = held_ms >= PROV_HOLD_RESET_MS ? 2 : held_ms >= PROV_HOLD_SETUP_MS ? 1 : 0;
  if (stage == last) return;
  last = stage;
  static const char *text[3][2] = {{"KEEP HOLDING", "FOR WI-FI SETUP"},
                                   {"RELEASE: WI-FI", "HOLD: RESET ALL"},
                                   {"RELEASE NOW:", "FACTORY RESET"}};
  display_text(text[stage], 2);
  ESP_LOGI(TAG, "BOOT HOLD %d ms: %s %s", held_ms, text[stage][0], text[stage][1]);
}

/** MENU+BACK at power-on: 3 s = the setup network, 10 s = factory reset. Returns "forced". */
static bool boot_keys(void) {
  int held = input_boot_hold_ms(show_hold);
  switch (prov_boot_hold(held)) {
    case PROV_HOLD_RESET: {
      ESP_LOGW(TAG, "FACTORY RESET (MENU+BACK held %d ms): erasing Wi-Fi, owner and keys", held);
      const char *lines[] = {"FACTORY RESET", "RESTARTING"};
      display_text(lines, 2);
      storage_wipe(false);  // everything: Wi-Fi, owner, keys
      vTaskDelay(pdMS_TO_TICKS(1500));
      esp_restart();
      return false;
    }
    case PROV_HOLD_SETUP:
      return true;
    case PROV_HOLD_NONE:
      return false;
  }
  return false;
}

// --- protocol ----------------------------------------------------------------------------

static void begin_pairing(void) {
  cJSON *m = msg("pair.begin");
  cJSON_AddStringToObject(m, "alg", "p256");
  cJSON_AddStringToObject(m, "kind", PHONE_KIND);
  cJSON_AddStringToObject(m, "publicKey", identity_public_key_b64());
  proto_send(m);
  s_code_at = now_ms();
}

static void on_open(void) {
  s_ws_open = true;
  s_authed = false;
  s_code[0] = '\0';
  end_call();
  ESP_LOGI(TAG, "WS open");
  cJSON *hello = msg("hello");
  cJSON_AddNumberToObject(hello, "proto", PROTOCOL_VERSION);
  const char *id = identity_device_id();
  if (id[0]) cJSON_AddStringToObject(hello, "deviceId", id);
  cJSON_AddStringToObject(hello, "model", "esp32s3");
  cJSON_AddStringToObject(hello, "fw", FW_VERSION);
  cJSON_AddNumberToObject(hello, "buttons", 10);
  cJSON_AddStringToObject(hello, "display", "eink");
  // What this phone shows truthfully beyond the base protocol (docs/protocol.md).
  cJSON *features = cJSON_AddArrayToObject(hello, "features");
  cJSON_AddItemToArray(features, cJSON_CreateString("missed-calls"));
  cJSON_AddItemToArray(features, cJSON_CreateString("call-waiting"));
  cJSON_AddItemToArray(features, cJSON_CreateString("key-pages"));
  proto_send(hello);
  s_last_ping = now_ms();
  if (!id[0]) begin_pairing();
}

static void forget_device_id(void) {
  s_unauthorized++;
  identity_set_device_id("");
  ESP_LOGW(TAG, "the server does not know this phone; it will pair again");
}

static void on_closed(int code) {
  if (code) ESP_LOGW(TAG, "WS closed (code %d)", code);
  else if (s_ws_open) ESP_LOGW(TAG, "WS closed");
  bool was_open = s_ws_open;
  s_ws_open = s_authed = false;
  s_code[0] = '\0';
  s_conn = CONN_OFFLINE;
  end_call();
  if (code == CLOSE_UNAUTHORIZED && identity_device_id()[0]) forget_device_id();
  // A new URL (the id was forgotten) needs a fresh client; otherwise the client reconnects.
  if (code == CLOSE_UNAUTHORIZED && s_unauthorized <= 3) s_reopen_at = now_ms() + 2000;
  (void)was_open;
}

static const char *jstr(const cJSON *o, const char *key) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
  return cJSON_IsString(v) ? v->valuestring : NULL;
}

/** For logging a field that may be missing. */
static const char *or_q(const char *s) { return s ? s : "?"; }

static void copy(char *dst, size_t n, const char *src) {
  snprintf(dst, n, "%s", src ? src : "");
}

/** A deadline from the server (`expiresAt`, ms since the epoch) on this phone's clock. */
static int64_t local_deadline(const cJSON *m, int64_t fallback_ms) {
  const cJSON *at = cJSON_GetObjectItemCaseSensitive(m, "expiresAt");
  struct timeval tv;
  gettimeofday(&tv, NULL);
  int64_t epoch = (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
  if (!cJSON_IsNumber(at) || epoch < 1700000000000LL) return now_ms() + fallback_ms;
  return now_ms() + ((int64_t)at->valuedouble - epoch);
}

static void on_config(const cJSON *m) {
  bool first = !s_authed;
  memset(&s_cfg, 0, sizeof s_cfg);
  s_cfg.present = true;
  const cJSON *b;
  cJSON_ArrayForEach(b, cJSON_GetObjectItemCaseSensitive(m, "buttons")) {
    const cJSON *idx = cJSON_GetObjectItemCaseSensitive(b, "index");
    if (cJSON_IsNumber(idx) && idx->valueint >= 0 && idx->valueint < KEYS_PER_PAGE)
      copy(s_cfg.labels[idx->valueint], sizeof s_cfg.labels[0], jstr(b, "label"));
  }
  // Speed-dial pages after the first (`key-pages`): stored as (page - 1) * 10 + slot.
  const cJSON *pg;
  cJSON_ArrayForEach(pg, cJSON_GetObjectItemCaseSensitive(m, "pages")) {
    const cJSON *page = cJSON_GetObjectItemCaseSensitive(pg, "page");
    if (!cJSON_IsNumber(page) || page->valueint < 2 || page->valueint > MAX_KEY_PAGES) continue;
    cJSON_ArrayForEach(b, cJSON_GetObjectItemCaseSensitive(pg, "buttons")) {
      const cJSON *idx = cJSON_GetObjectItemCaseSensitive(b, "index");
      if (!cJSON_IsNumber(idx) || idx->valueint < 0 || idx->valueint >= KEYS_PER_PAGE) continue;
      int at = (page->valueint - 1) * KEYS_PER_PAGE + idx->valueint;
      copy(s_cfg.labels[at], sizeof s_cfg.labels[0], jstr(b, "label"));
    }
  }
  s_cfg.quiet = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(m, "quiet"));
  copy(s_cfg.quiet_until, sizeof s_cfg.quiet_until, jstr(m, "quietUntil"));
  const cJSON *x;
  cJSON_ArrayForEach(x, cJSON_GetObjectItemCaseSensitive(m, "missed")) {
    if (s_cfg.missed_count < MAX_MISSED) {
      int k = s_cfg.missed_count;
      copy(s_cfg.missed[k], sizeof s_cfg.missed[0], jstr(x, "from"));
      s_cfg.missed_callback[k] = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(x, "callback"));
      const char *kind = jstr(x, "kind");
      s_cfg.missed_call[k] = kind && !strcmp(kind, "call");
      const cJSON *n = cJSON_GetObjectItemCaseSensitive(x, "count");
      const cJSON *at = cJSON_GetObjectItemCaseSensitive(x, "at");
      s_cfg.missed_n[k] = cJSON_IsNumber(n) ? n->valueint : 1;
      s_cfg.missed_at[k] = cJSON_IsNumber(at) ? (int64_t)at->valuedouble : 0;
      copy(s_cfg.missed_id[k], sizeof s_cfg.missed_id[0], jstr(x, "id"));
    }
    s_cfg.missed_count++;
  }
  const cJSON *owner = cJSON_GetObjectItemCaseSensitive(m, "owner");
  if (cJSON_IsObject(owner)) {
    copy(s_cfg.owner_mode, sizeof s_cfg.owner_mode, jstr(owner, "mode"));
    copy(s_cfg.owner_space, sizeof s_cfg.owner_space, jstr(owner, "space"));
    copy(s_cfg.owner_person, sizeof s_cfg.owner_person, jstr(owner, "person"));
  }
  s_lounge.on = !strcmp(s_cfg.owner_mode, "lounge");
  s_lounge.house_line = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(m, "houseLine"));
  const cJSON *here = cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(m, "here"), 0);
  copy(s_lounge.here, sizeof s_lounge.here, here ? jstr(here, "name") : "");
  for (char *c = s_lounge.here; *c; c++) *c = (char)toupper((unsigned char)*c);
  s_extensions = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(m, "extensions"));
  // Home features (each only when on for this phone).
  const cJSON *checkin = cJSON_GetObjectItemCaseSensitive(m, "checkin");
  if (cJSON_IsObject(checkin)) {
    copy(s_cfg.checkin_by, sizeof s_cfg.checkin_by, jstr(checkin, "by"));
    s_cfg.checkin_done = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(checkin, "done"));
    s_cfg.checkin_alerted = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(checkin, "alerted"));
    if (s_checkin_sent && s_cfg.checkin_done) {
      s_checkin_sent = false;
      s_checked_in_until = now_ms() + 4000;  // THANK YOU / CHECKED IN, now the server has it
      ESP_LOGI(TAG, "CHECK-IN counted");
    }
  }
  const cJSON *chime = cJSON_GetObjectItemCaseSensitive(m, "chime");
  copy(s_chime, sizeof s_chime, cJSON_IsObject(chime) ? jstr(chime, "text") : "");
  const cJSON *ic = cJSON_GetObjectItemCaseSensitive(m, "intercom");
  if (cJSON_IsObject(ic)) lan_config(jstr(ic, "room"), jstr(ic, "key"));
  else lan_config(NULL, NULL);
  const cJSON *off = cJSON_GetObjectItemCaseSensitive(m, "utcOffsetMin");
  if (cJSON_IsNumber(off)) {
    ota_set_utc_offset(off->valueint);
    s_utc_offset_min = off->valueint;
  }
  const cJSON *srv_now = cJSON_GetObjectItemCaseSensitive(m, "now");
  if (cJSON_IsNumber(srv_now)) ota_set_time((int64_t)srv_now->valuedouble);
  if (first) {
    // What the server speaks (additive `config.server`; older servers don't send it).
    const cJSON *server = cJSON_GetObjectItemCaseSensitive(m, "server");
    const cJSON *range = cJSON_GetObjectItemCaseSensitive(server, "protocol");
    const cJSON *lo = cJSON_GetObjectItemCaseSensitive(range, "min");
    const cJSON *hi = cJSON_GetObjectItemCaseSensitive(range, "max");
    if (cJSON_IsObject(server))
      ESP_LOGI(TAG, "SERVER %s protocol %d-%d (this phone: %d)", or_q(jstr(server, "software")),
               cJSON_IsNumber(lo) ? lo->valueint : 0, cJSON_IsNumber(hi) ? hi->valueint : 0,
               PROTOCOL_VERSION);
  }
  s_compat = COMPAT_OK;
  s_authed = true;
  s_conn = CONN_ONLINE;
  s_unauthorized = 0;
  ota_server_ok();  // a trial firmware reached the server and signed in: keep it
  if (first) {
    ESP_LOGI(TAG, "SIGNED IN as %s", identity_device_id());
    s_last_status = 0;  // report status right away
  }
}

static void on_message(char *text) {
  cJSON *m = cJSON_Parse(text);
  if (!m) {
    ESP_LOGW(TAG, "bad JSON from server");
    return;
  }
  const char *t = jstr(m, "t");
  if (!t) goto done;
  compat_t compat = compat_from_message(m, PROTOCOL_VERSION);
  if (compat != COMPAT_OK) {
    // The server can't talk to this phone: say which side needs an update, stop the client's
    // quick reconnects, and look again in an hour (either side may have been updated by then).
    ESP_LOGW(TAG, "%s: %s", compat == COMPAT_UPDATE_NEEDED ? "UPDATE NEEDED" : "SERVER TOO OLD",
             or_q(jstr(m, "message")));
    s_compat = compat;
    s_authed = false;
    net_ws_stop();
    s_reopen_at = now_ms() + COMPAT_RETRY_MS;
    goto done;
  }
  if (!strcmp(t, "rtc.config")) {
    // Never log TURN credentials: the call id and the server count only.
    ESP_LOGI("proto", "<- {\"t\":\"rtc.config\",\"callId\":\"%s\",…} (%d ICE servers; credentials not logged)",
             or_q(jstr(m, "callId")), cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(m, "iceServers")));
  } else if (strcmp(t, "pong")) {
    ESP_LOGI("proto", "<- %s", text);
  }

  if (!strcmp(t, "auth.challenge")) {
    uint8_t nonce[128];
    char sig[100];
    const char *n64 = jstr(m, "nonce");
    int n = n64 ? b64url_decode(n64, nonce, sizeof nonce) : -1;
    if (n > 0 && identity_sign_b64(nonce, (size_t)n, sig, sizeof sig)) {
      cJSON *p = msg("auth.proof");
      cJSON_AddStringToObject(p, "sig", sig);
      proto_send(p);
    } else {
      ESP_LOGE(TAG, "could not sign the challenge");
    }
  } else if (!strcmp(t, "pair.code")) {
    copy(s_code, sizeof s_code, jstr(m, "code"));
    s_code_at = now_ms();
    ota_server_ok();  // a trial firmware reached the server: keep it
    printf("PAIRING CODE: %s\n", s_code);  // the owner types this into the companion app
    fflush(stdout);
    signals_beep(BEEP_PAIR);
  } else if (!strcmp(t, "pair.done")) {
    const char *id = jstr(m, "deviceId");
    ESP_LOGI(TAG, "PAIRED device=%s household=%s", or_q(id), or_q(jstr(m, "householdId")));
    identity_set_device_id(id);
    s_code[0] = '\0';
    signals_beep(BEEP_OK);
    open_socket();  // reconnect with ?device= (routes to the household)
  } else if (!strcmp(t, "config")) {
    on_config(m);
  } else if (!strcmp(t, "wipe")) {
    ESP_LOGW(TAG, "WIPE (%s): erasing the device key and settings, then rebooting",
             or_q(jstr(m, "reason")));
    const char *lines[] = {"REMOVED", "RESETTING"};
    display_text(lines, 2);
    identity_wipe();
    vTaskDelay(pdMS_TO_TICKS(1500));
    esp_restart();
  } else if (!strcmp(t, "error")) {
    const char *code = jstr(m, "code");
    ESP_LOGW(TAG, "server error %s: %s", or_q(code), or_q(jstr(m, "message")));
    if (code && !strcmp(code, "unauthorized") && identity_device_id()[0]) forget_device_id();
  } else if (!strcmp(t, "lounge.idle")) {
    lounge_idle(&s_lounge, jstr(m, "nonce"), local_deadline(m, 55000));
  } else if (!strcmp(t, "lounge.challenge")) {
    const cJSON *idx = cJSON_GetObjectItemCaseSensitive(m, "index");
    if (cJSON_IsNumber(idx)) lounge_challenge(&s_lounge, idx->valueint, local_deadline(m, 30000));
    menu_close(&s_menu);
    ESP_LOGI(TAG, "LOUNGE challenge: press key %d", cJSON_IsNumber(idx) ? idx->valueint : -1);
  } else if (!strcmp(t, "lounge.session")) {
    lounge_session(&s_lounge, jstr(m, "name"), cJSON_IsTrue(cJSON_GetObjectItem(m, "openToChat")));
    ESP_LOGI(TAG, "LOUNGE session started");
  } else if (!strcmp(t, "lounge.ended")) {
    // Forget the person: their name, keys, missed calls and the last caller.
    lounge_ended(&s_lounge, jstr(m, "reason"), now_ms());
    memset(s_cfg.labels, 0, sizeof s_cfg.labels);
    memset(s_cfg.missed, 0, sizeof s_cfg.missed);
    s_cfg.missed_count = 0;
    s_active_label[0] = '\0';
    menu_close(&s_menu);
    vmplay_stop();
    ESP_LOGI(TAG, "LOUNGE session ended (%s): forgot everything", or_q(jstr(m, "reason")));
  } else if (!strcmp(t, "voicemail.items")) {
    vmplay_items(m, now_ms());
  } else if (!strcmp(t, "notice")) {
    bool fresh = notice_set(&s_notice, m);
    ESP_LOGI(TAG, "NOTICE %s [%s|%s]%s", s_notice.id, s_notice.lines[0], s_notice.lines[1],
             s_notice.token[0] ? " recorded" : "");
    // A chime for a new one, never during quiet hours, a call or with the handset up.
    if (fresh && !s_cfg.quiet && s_phone.kind == PH_IDLE && !s_hook_up) signals_beep(BEEP_NOTICE);
  } else if (!strcmp(t, "notice.cleared")) {
    notice_clear(&s_notice, jstr(m, "id"));
  } else if (!strcmp(t, "rtc.config")) {
    // ICE servers for a call: start its peer connection now, so gathering (STUN/TURN) overlaps
    // with the signaling. The caller offers (it is still dialing here), the callee answers.
    const char *call = jstr(m, "callId");
    bool dialing = s_phone.kind == PH_DIALING && (!s_phone.call_id[0] || !strcmp(s_phone.call_id, call ? call : ""));
    bool answering = s_phone.kind == PH_INCALL && call && !strcmp(s_phone.call_id, call);
    if (call && (dialing || answering) && !cJSON_HasObjectItem(m, "peer")) {
      free(s_local_sdp);
      s_local_sdp = NULL;
      s_rtc_offerer = dialing;
      media_start(call, dialing, cJSON_GetObjectItemCaseSensitive(m, "iceServers"));
    } else {
      ESP_LOGI(TAG, "rtc.config for %s ignored (%s)", or_q(call), phone_kind_name(s_phone.kind));
    }
  } else if (!strcmp(t, "rtc.sdp")) {
    const char *call = jstr(m, "callId"), *sdp = jstr(m, "sdp");
    if (call && sdp && !cJSON_HasObjectItem(m, "peer")) media_remote_sdp(call, sdp);
  } else if (!strcmp(t, "rtc.ice")) {
    const char *call = jstr(m, "callId"), *cand = jstr(m, "candidate");
    if (call && cand && !cJSON_HasObjectItem(m, "peer")) media_remote_candidate(call, cand);
  } else if (!strcmp(t, "room.media")) {
    // TODO: rooms (mesh or relay) need more than one peer connection; not in this firmware yet.
  } else if (!strcmp(t, "call.ringing") && lan_busy() && s_phone.kind == PH_IDLE) {
    // On the house intercom: a call through the server is busy meanwhile.
    const char *call = jstr(m, "callId");
    ESP_LOGI(TAG, "call %s while on the intercom: busy", or_q(call));
    if (call) {
      cJSON *h = msg("call.hangup");
      cJSON_AddStringToObject(h, "callId", call);
      emit(h);
    }
  } else if (phone_repeated_end(&s_ends, m)) {
    // A second ended for a call that already ended here can't end the next one.
    ESP_LOGI(TAG, "repeated end of %s ignored", or_q(jstr(m, "callId")));
  } else {
    phone_kind_t before = s_phone.kind;
    if (phone_server(&s_phone, m, emit)) {
      if (s_phone.kind == PH_INCOMING && before != PH_INCOMING) {
        if (s_phone.addon) {
          char label[STATUS_MAX + 1];
          strip_addon_label(label, s_phone.from);  // ≤ 24 characters: the name fits
          snprintf(s_active_label, sizeof s_active_label, "%.24s", label);
        } else {
          copy(s_active_label, sizeof s_active_label, s_phone.from);
        }
        menu_close(&s_menu);
      }
      if (s_phone.kind == PH_VOICEMAIL && before != PH_VOICEMAIL) {
        ESP_LOGI(TAG, "voicemail offered for %s (up to %d s)", s_phone.from, s_phone.vm_max_ms / 1000);
        if (s_hook_up) vm_leave_start(s_phone.vm_ticket, s_phone.vm_max_ms, now_ms());
      }
    }
  }
done:
  cJSON_Delete(m);
}

// --- inputs ------------------------------------------------------------------------------

/** Clears the notice on this phone (a key while it shows, or while its recording plays). */
static void dismiss_notice(void) {
  cJSON *d = msg("notice.dismiss");
  cJSON_AddStringToObject(d, "id", s_notice.id);
  emit(d);
  ESP_LOGI(TAG, "NOTICE %s dismissed", s_notice.id);
  notice_init(&s_notice);
}

static void on_key(int index) {
  int64_t now = now_ms();
  signals_beep(BEEP_KEY);
  // A notice's recording playing over and over: any key stops it and clears the notice.
  if (vmplay_looping()) {
    vmplay_stop();
    if (s_notice.active) dismiss_notice();
    return;
  }
  if (vmplay_key(index, now)) return;  // listening to voicemail: 1 again, 2 next, BACK stop
  if (selftest_active()) {  // the self-test takes every key, MENU and BACK too
    selftest_key(index, now);
    return;
  }
  menu_screen_t was = s_menu.screen;
  // MENU opens the menu in every state; in a call or a room it opens the call screen.
  s_menu.n_actions = phone_actions(&s_phone, s_menu.actions);
  s_menu.in_call = s_phone.kind != PH_INROOM;
  if ((was != MENU_CLOSED || index == KEY_MENU_INDEX) && menu_key(&s_menu, index, now)) {
    ESP_LOGI(TAG, "MENU %s", menu_screen_name(s_menu.screen));
    if (s_menu.screen == MENU_ABOUT) {
      const char *const *w = identity_fingerprint();
      ESP_LOGI(TAG, "ABOUT fw=%s words=%s %s %s %s", FW_VERSION, w[0], w[1], w[2], w[3]);
    }
    return;
  }
  // A notice on the ready screen: any key (BACK too) dismisses it on this phone.
  if (s_notice.active && s_phone.kind == PH_IDLE && !s_hook_up && index != KEY_MENU_INDEX) {
    dismiss_notice();
    return;
  }
  // The house intercom: BACK stops a call on it; other keys wait while it's busy.
  if (lan_busy()) {
    if (index == KEY_BACK_INDEX) lan_cancel();
    return;
  }
  // The daily check-in due: 1 (handset down) is I'm OK.
  if (index == 0 && s_phone.kind == PH_IDLE && !s_hook_up && s_cfg.checkin_by[0] &&
      !s_cfg.checkin_done && s_authed) {
    emit(msg("checkin.ok"));
    s_checkin_sent = true;
    ESP_LOGI(TAG, "CHECK-IN: I'm OK sent");
    return;
  }
  // Ringing: BACK silences the ringer on this phone (lifting still answers).
  if (index == KEY_BACK_INDEX && s_phone.kind == PH_INCOMING) {
    phone_silence(&s_phone);
    ESP_LOGI(TAG, "RING silenced on this phone");
    return;
  }
#if CONFIG_OLP_LABS
  if (labs_key(index, s_hook_up, now)) return;   // intercom, home, stories, macro, check-in…
#endif
  // The speed-dial screen with more than one page of keys: BACK shows the next (wrapping).
  if (index == KEY_BACK_INDEX && s_phone.kind == PH_OFFHOOK && s_hook_up && s_authed) {
    int pages[MAX_KEY_PAGES];
    int n = strip_key_pages(&s_cfg, pages);
    phone_page(&s_phone, pages, n);
    if (n > 1) ESP_LOGI(TAG, "KEYS page %d of %d", s_phone.page > 1 ? s_phone.page : 1, n);
    return;
  }
  if (index >= 10) return;  // MENU/BACK outside the menu
  if (s_lounge.on && s_lounge.challenge >= 0 && s_authed) {
    // The takeover proof: the key the screen names (any key is sent; the server checks it).
    cJSON *p = msg("lounge.press");
    cJSON_AddNumberToObject(p, "index", index);
    emit(p);
    return;
  }
  if (!lounge_keys_live(&s_lounge)) {
    ESP_LOGI(TAG, "key %d: Lounge phone not taken over", index);
    return;
  }
  if (!s_authed) {
    ESP_LOGI(TAG, "key %d: not signed in yet", index);
    return;
  }
  if (s_phone.kind == PH_OFFHOOK && s_phone.held[0]) {
    // One call has audio at a time here: resume the held call first (MENU 1).
    ESP_LOGI(TAG, "key %d: a call is on hold", index);
    return;
  }
  phone_kind_t before = s_phone.kind;
  phone_button(&s_phone, index, emit);
  if (before == PH_OFFHOOK && s_phone.kind == PH_DIALING && s_phone.button >= 0) {
    // The key on the page shown: its stored index is (page - 1) * 10 + slot.
    copy(s_active_label, sizeof s_active_label, s_cfg.labels[s_phone.button]);
    save_last_dial(&(last_dial_t){.kind = DIAL_KEY, .index = s_phone.button});
  }
}

/** Lifting the handset with a recorded notice showing plays it in the earpiece. */
static void play_notice(void) {
  char path[300], srv[PROV_SERVER_MAX], base[PROV_SERVER_MAX + 8], url[PROV_SERVER_MAX + 320];
  if (!notice_audio_path(&s_notice, path, sizeof path)) return;
  net_server_url(srv, sizeof srv);
  if (!strncmp(srv, "wss://", 6)) snprintf(base, sizeof base, "https://%s", srv + 6);
  else if (!strncmp(srv, "ws://", 5)) snprintf(base, sizeof base, "http://%s", srv + 5);
  else snprintf(base, sizeof base, "%s", srv);
  size_t bl = strlen(base);
  if (bl && base[bl - 1] == '/') base[bl - 1] = '\0';
  snprintf(url, sizeof url, "%s%s", base, path);
  ESP_LOGI(TAG, "NOTICE %s playing (until the handset goes down or a key)", s_notice.id);
  char text[50];
  snprintf(text, sizeof text, "%s%s%s", s_notice.lines[0], s_notice.lines[1][0] ? " " : "",
           s_notice.lines[1]);
  vmplay_loop_url(url, text, now_ms());
}

static void on_hook(bool up) {
  bool notice_audio = up && s_phone.kind == PH_IDLE && s_menu.screen == MENU_CLOSED &&
                      s_notice.active && s_notice.token[0];
  s_hook_up = up;
  if (!up) vm_leave_finish(now_ms());  // hanging up sends a message being recorded
  if (!up) vmplay_stop();              // …and stops one playing
  selftest_hook(up, now_ms());
  if (s_menu.screen != MENU_CLOSED) menu_close(&s_menu);
  // The intercom answered: the phone's own call logic leaves the lift alone. Hanging up always
  // reaches it too, so a phone lifted to call a room isn't left off the hook.
  if (lan_hook(up, now_ms()) && up) return;
#if CONFIG_OLP_LABS
  if (labs_hook(up, now_ms()) && up) return;  // a story pressed before lifting
#endif
  phone_hook(&s_phone, up, emit);
  if (notice_audio) play_notice();
}

// --- main loop ---------------------------------------------------------------------------

static void ota_tick(int64_t now) {
  bool quiet = s_phone.kind == PH_IDLE && !s_hook_up && s_menu.screen == MENU_CLOSED &&
               !prov_ap_active();
  if (!quiet) s_idle_since = -1;
  else if (s_idle_since < 0) s_idle_since = now;
  // An installed update restarts the phone only when nothing is going on.
  bool free_now = s_phone.kind == PH_IDLE || (s_phone.kind == PH_OFFHOOK && s_ota_manual);
  if (s_ota_restart && free_now && s_menu.screen == MENU_CLOSED) {
    ESP_LOGI(TAG, "OTA RESTART into the new firmware");
    const char *lines[] = {"UPDATED", "RESTARTING"};
    display_text(lines, 2);
    vTaskDelay(pdMS_TO_TICKS(1000));
    esp_restart();
  }
  if (s_next_ota_check >= 0 && now >= s_next_ota_check && ota_state() == OTA_IDLE) {
    s_next_ota_check = now + OTA_CHECK_EVERY_MS;
    if (ota_enabled()) ota_check(false);  // off (the default for source builds): no calls at all
  }
  ota_ctx_t ctx = {
      .on_hook = !s_hook_up,
      .idle = quiet,
      .idle_ms = s_idle_since < 0 ? 0 : now - s_idle_since,
      .local_minute = ota_local_minute(),
#if CONFIG_OLP_OTA_NIGHT_ONLY
      .night_only = true,
#endif
  };
  if (ota_available()[0] && !s_ota_restart && ota_state() == OTA_IDLE && ota_may_install(&ctx)) {
    ESP_LOGI(TAG, "OTA auto install of %s (idle %lld s, local minute %d)", ota_available(),
             (long long)(ctx.idle_ms / 1000), ctx.local_minute);
    ota_check(true);
  }
}

static void finish_selftest(void) {
  audio_force_tone(TONE_NONE);
  bool ok = selftest_passed();
  signals_beep(ok ? BEEP_OK : BEEP_ERROR);
  ESP_LOGI(TAG, "SELFTEST %s", ok ? "passed" : "ended unfinished");
}

static void tick(void) {
  int64_t now = now_ms();
  if (vmplay_active() && s_phone.kind == PH_INCOMING) vmplay_stop();  // a call comes first
  if (selftest_active() && s_phone.kind == PH_INCOMING) {  // a call comes first
    selftest_stop();
    finish_selftest();
  } else if (selftest_tick(now)) {
    finish_selftest();
  }
  vm_leave_tick(now);
  lan_tick(now);
  // In a call through the server: a ring on the house intercom gets busy.
  lan_set_engaged(s_phone.kind != PH_IDLE && s_phone.kind != PH_OFFHOOK);
  if (s_reconnect_since >= 0 && (s_phone.kind != PH_INCALL || !media_active())) s_reconnect_since = -1;
  if (s_reconnect_since >= 0 && now - s_reconnect_since >= RECONNECT_GIVE_UP_MS) {
    ESP_LOGW(TAG, "call media didn't come back: CONNECTION LOST");
    s_reconnect_since = -1;
    media_stop();
    phone_lost(&s_phone, emit);
  }
  lounge_tick(&s_lounge, now);
  bool idle_screen = s_authed && s_conn == CONN_ONLINE && s_phone.kind == PH_IDLE && !s_hook_up;
  if (lounge_wants_refresh(&s_lounge, idle_screen, s_menu.screen != MENU_CLOSED, now))
    emit(msg("lounge.refresh"));
  vmplay_tick(now);
#if CONFIG_OLP_LABS
  labs_tick(now);
#endif
  ota_tick(now);
  menu_tick(&s_menu, now);
  if (s_reopen_at >= 0 && now >= s_reopen_at) {
    s_reopen_at = -1;
    open_socket();
  }
  if (s_ws_open && now - s_last_ping >= PING_MS) {
    proto_ping();
    s_last_ping = now;
  }
  // Codes expire: ask for a fresh one shortly before that happens.
  if (s_ws_open && s_code[0] && now - s_code_at >= PAIR_REFRESH_MS) begin_pairing();
  if (s_authed && now - s_last_status >= STATUS_MS) {
    char ssid[33], ip[16];
    int rssi;
    net_wifi_info(ssid, sizeof ssid, &rssi, ip, sizeof ip);
    cJSON *st = msg("status");
    if (rssi) cJSON_AddNumberToObject(st, "rssi", rssi);
    cJSON_AddNumberToObject(st, "uptimeS", (double)(now / 1000));
    cJSON *power = cJSON_AddObjectToObject(st, "power");
    cJSON_AddStringToObject(power, "source", "default");  // no CC sensing on the minimal board
    cJSON_AddBoolToObject(power, "reduced", false);
    proto_send(st);
    s_last_status = now;
  }
}

void app_main(void) {
  ESP_ERROR_CHECK(storage_init());  // NVS (encrypted in release builds)
  s_queue = xQueueCreate(32, sizeof(app_event_t));
#if CONFIG_OLP_QEMU
  ESP_LOGI(TAG, "Open Lounge Phone firmware %s (simulator build: QEMU)", FW_VERSION);
#elif CONFIG_OLP_SIM
  ESP_LOGI(TAG, "Open Lounge Phone firmware %s (simulator build)", FW_VERSION);
#else
  ESP_LOGI(TAG, "Open Lounge Phone firmware %s", FW_VERSION);
#endif
  phone_init(&s_phone);
  ota_boot();
#if CONFIG_OLP_TEST_CRASH_AT_BOOT
  ESP_LOGE(TAG, "TEST BUILD: crashing at boot on purpose (the OTA rollback test)");
  abort();
#endif

  // The QR library logs the text it encodes: the setup network's password, a takeover link.
  esp_log_level_set("QRCODE", ESP_LOG_WARN);
  signals_start();
#if CONFIG_OLP_QEMU
  display_start(&display_none);
#elif CONFIG_OLP_SIM
  display_start(&display_ili9341_sim);
#else
  display_start(&display_epd_ssd1680);
#endif
  bool forced_setup = boot_keys();
  {
    int w, h;
    display_size(&w, &h);
    uint8_t *fb = calloc(1, (size_t)(w * h + 7) / 8);
    if (fb && !forced_setup) {
      screen_boot(fb, w, h, FW_VERSION);
      display_pixels(fb);
      s_boot_until = now_ms() + 2500;
    }
    free(fb);
  }
  net_start();       // starts the radio: esp_fill_random is truly random from here on
  identity_init();   // loads or generates the device key
#if CONFIG_OLP_AUDIO_TEST_DEVICE
  audio_start(true);
#else
  audio_start(false);
#endif
  media_init();
#if CONFIG_OLP_LABS
  labs_start();
#endif
  vmplay_init(emit);
  lan_init();  // the house intercom, if it's on (its key is kept for days without internet)
  input_start();
  console_start();
  prov_init(&s_prov);
#if BOARD_HAS_ETHERNET
  // With a cable the setup network waits for the network choice (a few seconds), unless asked for.
  if (forced_setup || net_settled()) {
    s_prov_booted = true;
    prov_event(PROV_EV_BOOT, forced_setup);
  }
#else
  prov_event(PROV_EV_BOOT, forced_setup);
#endif
  render();

  for (;;) {
    app_event_t ev;
    if (xQueueReceive(s_queue, &ev, pdMS_TO_TICKS(100)) == pdTRUE) {
      switch (ev.type) {
        case EV_KEY: on_key(ev.a); break;
        case EV_HOOK: on_hook(ev.a); break;
        case EV_JACK:  // nothing to switch (the mic is only read in a call); shown by MENU 7
          s_jack_in = ev.a;
          selftest_jack(ev.a, now_ms());
          break;
        case EV_CALL_ACTION:
          ESP_LOGI(TAG, "CALL ACTION %s", phone_action_name((phone_action_t)ev.a));
          phone_action(&s_phone, (phone_action_t)ev.a, emit);
          break;
        case EV_VM_SENT:
          vm_leave_sent(ev.a, now_ms());
          signals_beep(ev.a ? BEEP_OK : BEEP_ERROR);
          break;
        case EV_VM_PLAY:
          if (ev.a == 0 && !s_hook_up) {  // listening needs the handset
            snprintf(s_ota_msg[0], 25, "LIFT THE HANDSET");
            snprintf(s_ota_msg[1], 25, "THEN MENU 2 1");
            s_ota_msg_until = now_ms() + 4000;
          } else if (s_authed) {
            // 3 Clear marks the messages heard (missed calls are cleared on MENU 5).
            if (ev.a == 0 || s_menu.voicemail > 0) vmplay_start(ev.a == 1, now_ms());
          }
          break;
        case EV_VM_LOADED:
          vmplay_loaded(ev.a, now_ms());
          break;
        case EV_EXT_DIAL:
          if (ev.a == 1) {  // from the call screen: transfer the call to it
            ESP_LOGI(TAG, "CALL ACTION transfer to extension %s", ev.data ? ev.data : "?");
            phone_transfer_extension(&s_phone, ev.data, emit);
          } else if (!s_hook_up || s_phone.kind != PH_OFFHOOK) {
            snprintf(s_ota_msg[0], 25, "LIFT THE HANDSET");
            snprintf(s_ota_msg[1], 25, "THEN MENU 6");
            s_ota_msg_until = now_ms() + 4000;
          } else if (ev.data) {
            snprintf(s_active_label, sizeof s_active_label, "EXT %s", ev.data);
            phone_extension(&s_phone, ev.data, emit);
            last_dial_t d = {.kind = DIAL_EXT};
            snprintf(d.text, sizeof d.text, "%s", ev.data);
            save_last_dial(&d);
          }
          free(ev.data);
          break;
        case EV_CALL_BACK:
        case EV_REDIAL: {
          // Both dial: the handset must be up, with nothing else going on.
          last_dial_t d = {.kind = DIAL_BACK};
          if (ev.type == EV_CALL_BACK) snprintf(d.text, sizeof d.text, "%s", ev.data ? ev.data : "");
          bool have = ev.type == EV_CALL_BACK ? d.text[0] != '\0' : load_last_dial(&d);
          free(ev.data);
          if (!have) {
            snprintf(s_ota_msg[0], 25, "NOTHING TO REDIAL");
            s_ota_msg[1][0] = '\0';
            s_ota_msg_until = now_ms() + 4000;
            break;
          }
          if (!s_hook_up || s_phone.kind != PH_OFFHOOK || s_phone.held[0]) {
            snprintf(s_ota_msg[0], 25, "LIFT THE HANDSET");
            snprintf(s_ota_msg[1], 25, "THEN MENU %d", ev.type == EV_CALL_BACK ? 5 : 8);
            s_ota_msg_until = now_ms() + 4000;
            break;
          }
          ESP_LOGI(TAG, "%s %s", ev.type == EV_CALL_BACK ? "CALL BACK" : "REDIAL",
                   d.kind == DIAL_KEY ? "key" : d.kind == DIAL_EXT ? d.text : "missed call");
          if (d.kind == DIAL_KEY) {
            // The same key on the same page, whatever page is on screen.
            copy(s_active_label, sizeof s_active_label, s_cfg.labels[d.index]);
            phone_key(&s_phone, d.index % KEYS_PER_PAGE, d.index / KEYS_PER_PAGE + 1, emit);
          } else if (d.kind == DIAL_EXT) {
            snprintf(s_active_label, sizeof s_active_label, "EXT %.20s", d.text);
            phone_extension(&s_phone, d.text, emit);
          } else {
            s_active_label[0] = '\0';
            for (int i = 0; i < s_cfg.missed_count && i < MAX_MISSED; i++)
              if (!strcmp(s_cfg.missed_id[i], d.text)) copy(s_active_label, sizeof s_active_label, s_cfg.missed[i]);
            phone_call_back(&s_phone, d.text, emit);
          }
          if (s_phone.kind == PH_DIALING) save_last_dial(&d);
          break;
        }
        case EV_LAN:
          lan_event(ev.data, now_ms());
          break;
        case EV_INTERCOM: {
          // Calling a room needs the handset up and nothing else going on.
          if (!s_hook_up || s_phone.kind != PH_OFFHOOK || s_phone.held[0]) {
            snprintf(s_ota_msg[0], 25, "LIFT THE HANDSET");
            snprintf(s_ota_msg[1], 25, "THEN MENU 4");
            s_ota_msg_until = now_ms() + 4000;
            break;
          }
          char rooms[8][25];
          int n = lan_rooms(rooms, 8, now_ms());
          const char *to = ev.a < 0 ? "*" : ev.a < n ? rooms[ev.a] : NULL;
          if (to && lan_call(to, false, now_ms())) ESP_LOGI(TAG, "INTERCOM calling %s", to);
          break;
        }
        case EV_CHIME:
          if (s_authed && s_chime[0]) {
            emit(msg("notice.chime"));
            ESP_LOGI(TAG, "CHIME sent");
          }
          break;
        case EV_MISSED_CLEAR:
          if (s_authed) emit(msg("missed.clear"));
          break;
        case EV_LOUNGE_CHAT: {
          cJSON *c = msg("lounge.chat");
          cJSON_AddBoolToObject(c, "open", ev.a);
          emit(c);
          break;
        }
        case EV_LOUNGE_LEAVE:
          emit(msg("lounge.leave"));
          break;
        case EV_LABS:
#if CONFIG_OLP_LABS
          labs_event(ev.a, ev.data, now_ms());
#else
          free(ev.data);   // only the labs build posts these
#endif
          break;
        case EV_ECHO_TEST:
          // The handset up on the phone check, not in a call: a sweep in the earpiece.
          if (s_hook_up && s_phone.kind == PH_OFFHOOK && !s_phone.held[0] && audio_echo_test())
            s_check_drawn = 0;  // show TESTING now
          break;
        case EV_SELFTEST:
          if (s_phone.kind == PH_IDLE || (s_phone.kind == PH_OFFHOOK && !s_phone.held[0])) {
            selftest_start(now_ms(), s_hook_up, s_jack_in);
            audio_force_tone(TONE_TEST);  // the earpiece: a 1 kHz tone with the handset up
            signals_beep(BEEP_OK);        // the piezo
            ESP_LOGI(TAG, "SELFTEST started");
          }
          break;
        case EV_WIFI_UP:
          network_up(false);
          break;
        case EV_WIFI_DOWN:
          network_down();
          break;
        case EV_NET:  // hw v0.901: the cable or Wi-Fi changed (netsel.c); never on rev A
#if BOARD_HAS_ETHERNET
          network_changed(net_select(ev.a, network_busy()));
#endif
          break;
        case EV_OTA_NOW:
          if (s_phone.kind == PH_IDLE || s_phone.kind == PH_OFFHOOK) {
            s_ota_manual = true;
            ota_check(true);
          } else {
            ESP_LOGI(TAG, "OTA: not during a call");
          }
          break;
        case EV_OTA_DONE:
          if (ev.a == 2) s_ota_restart = true;
          if (ev.a == OTA_RESULT_OFF) s_ota_manual = true;  // MENU 9 or `ota now`: say so
          if (s_ota_manual && ev.a != 2) {
            static const char *msg[][2] = {{"UPDATE FAILED", "TRY LATER"},
                                           {"UP TO DATE", ""},
                                           {"UPDATE FOUND", ""},
                                           {"UPDATES", "NOT SET UP"}};
            int i = ev.a == OTA_RESULT_OFF ? 3 : ev.a < 0 ? 0 : ev.a == 0 ? 1 : 2;
            snprintf(s_ota_msg[0], 25, "%s", msg[i][0]);
            snprintf(s_ota_msg[1], 25, "%s", msg[i][1]);
            s_ota_msg_until = now_ms() + 5000;
            s_ota_manual = false;
          }
          break;
        case EV_PROV_OPEN:
          prov_event(PROV_EV_OPEN, false);
          break;
        case EV_PROV_SAVED:
          prov_event(PROV_EV_SAVED, false);
          break;
        case EV_WS_OPEN: on_open(); break;
        case EV_WS_CLOSED: on_closed(ev.a); break;
        case EV_WS_MSG:
          on_message(ev.data);
          free(ev.data);
          break;
        case EV_DROP:
          ESP_LOGW(TAG, "dropping the WebSocket (console)");
          on_closed(0);
          net_ws_close();
          s_reopen_at = now_ms() + 3000;
          break;
        case EV_WIPE:
          identity_wipe();
          esp_restart();
          break;
        case EV_RECONNECT:
          if (s_started) open_socket();
          break;
        case EV_RTC_SDP:
          if (media_active()) {
            free(s_local_sdp);
            s_local_sdp = ev.data;  // sent by sync_media once the call is connecting
          } else {
            free(ev.data);
          }
          break;
        case EV_RTC_STATE:
          if (ev.a == 1) {
            if (s_reconnect_since >= 0) ESP_LOGI(TAG, "call media back");
            s_reconnect_since = -1;
          } else if (ev.a == 2 && media_active()) {
            // Dropped mid-call: RECONNECTING while it may come back by itself (esp_peer can't
            // restart ICE); tick() ends the call as lost if it doesn't.
            ESP_LOGW(TAG, "call media lost: RECONNECTING (up to %d s)", RECONNECT_GIVE_UP_MS / 1000);
            if (s_reconnect_since < 0) s_reconnect_since = now_ms();
          } else if (ev.a == 3 && media_active()) {
            // Never connected: hang up (the caller hears it ended) rather than sit in silence.
            ESP_LOGW(TAG, "call media failed: hanging up");
            media_stop();
            phone_hangup(&s_phone, "error", emit);
          }
          break;
      }
    }
    tick();
#if BOARD_HAS_ETHERNET
    network_changed(net_select(NS_TICK, network_busy()));  // looks for a cable, timeouts
    if (!s_prov_booted && net_settled()) {
      // The power-on network choice is made: now setup knows whether a network is missing.
      s_prov_booted = true;
      prov_event(PROV_EV_BOOT, false);
    }
#endif
    prov_event(PROV_EV_TICK, false);
    sync_media();
    render();
  }
}
