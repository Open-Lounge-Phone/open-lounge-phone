// Open Lounge Phone firmware v0: the app task. It owns all phone state; inputs, the network and
// the console only post events to it. Mirrors apps/device-web/src/main.ts (the browser phone):
// hello → (unpaired) pair.begin → pair.code … pair.done → reconnect → auth.challenge →
// auth.proof → config, then the handset state machine (phone.c = deviceStep).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app.h"
#include "board.h"
#include "cJSON.h"
#include "codec.h"
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
#include "nvs_flash.h"
#include "phone.h"
#include "proto.h"
#include "signals.h"
#include "strip.h"

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
static menu_t s_menu;
static char s_active_label[25];
static int64_t s_call_started = -1;
static char s_shown[4][25];
static int s_shown_n = -1;
static phone_kind_t s_logged_kind = PH_IDLE;

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

static void open_socket(void) {
  char url[200];
  socket_url(url, sizeof url);
  s_ws_open = s_authed = false;
  s_conn = CONN_CONNECTING;
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

static void end_call(void) {
  phone_init(&s_phone);
  if (s_hook_up) s_phone.kind = PH_OFFHOOK;
  s_call_started = -1;
}

// --- rendering ---------------------------------------------------------------------------

static void render(void) {
  int64_t now = now_ms();
  if (s_phone.kind != s_logged_kind) {
    ESP_LOGI(TAG, "STATE %s", phone_kind_name(s_phone.kind));
    s_logged_kind = s_phone.kind;
  }
  if (s_phone.kind == PH_INCALL && s_phone.connected) {
    if (s_call_started < 0) s_call_started = now;
  } else {
    s_call_started = -1;
  }

  char lines[4][25] = {{0}};
  int n = menu_lines(&s_menu, lines);
  if (n == 0) {
    char strip[2][STATUS_WIDTH + 1];
    strip_input_t in = {
        .connection = s_conn,
        .pairing_code = s_code[0] ? s_code : NULL,
        .no_wifi = false,
        .state = &s_phone,
        .config = &s_cfg,
        .active_label = s_active_label,
        .call_started_ms = s_call_started,
        .now_ms = now,
    };
    char ssid[33], ip[16];
    int rssi;
    net_wifi_info(ssid, sizeof ssid, &rssi, ip, sizeof ip);
    in.no_wifi = ssid[0] == '\0';
    n = strip_lines(&in, strip);
    for (int i = 0; i < n; i++) strlcpy(lines[i], strip[i], sizeof lines[i]);
  }
  if (n != s_shown_n || memcmp(lines, s_shown, sizeof s_shown)) {
    memcpy(s_shown, lines, sizeof s_shown);
    s_shown_n = n;
    ESP_LOGI(TAG, "STRIP [%s%s%s%s%s%s%s]", lines[0], n > 1 ? "|" : "", n > 1 ? lines[1] : "",
             n > 2 ? "|" : "", n > 2 ? lines[2] : "", n > 3 ? "|" : "", n > 3 ? lines[3] : "");
    const char *ptrs[4] = {lines[0], lines[1], lines[2], lines[3]};
    display_text(ptrs, n);
  }

  // The status LED (leds.ts `status`, on a single-colour LED) and the ringer.
  led_pattern_t led;
  if (s_code[0] || s_conn == CONN_CONNECTING) led = LED_PULSE;
  else if (s_conn == CONN_OFFLINE) led = LED_BLINK;
  else if (s_phone.kind == PH_INCOMING) led = LED_RINGING;
  else if (s_phone.kind == PH_INCALL || s_phone.kind == PH_INROOM || s_phone.kind == PH_DIALING)
    led = LED_ON;
  else if (s_phone.kind == PH_IDLE && s_cfg.missed_count > 0) led = LED_BREATHE;
  else led = LED_DIM;
  signals_led(led);
  signals_ring(s_phone.kind == PH_INCOMING);
}

void app_print_status(void) {
  char ssid[33], ip[16];
  int rssi;
  net_wifi_info(ssid, sizeof ssid, &rssi, ip, sizeof ip);
  const char *const *w = identity_fingerprint();
  static const char *conns[] = {"connecting", "online", "offline"};
  printf("STATUS state=%s conn=%s authed=%d device=%s code=%s wifi=%s rssi=%d ip=%s "
         "words=%s-%s-%s-%s missed=%d strip=%s|%s menu=%s\n",
         phone_kind_name(s_phone.kind), conns[s_conn], s_authed,
         identity_device_id()[0] ? identity_device_id() : "-", s_code[0] ? s_code : "-",
         ssid[0] ? ssid : "-", rssi, ip[0] ? ip : "-", w[0], w[1], w[2], w[3], s_cfg.missed_count,
         s_shown[0], s_shown[1], menu_screen_name(s_menu.screen));
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

static void on_config(const cJSON *m) {
  bool first = !s_authed;
  memset(&s_cfg, 0, sizeof s_cfg);
  s_cfg.present = true;
  const cJSON *b;
  cJSON_ArrayForEach(b, cJSON_GetObjectItemCaseSensitive(m, "buttons")) {
    const cJSON *idx = cJSON_GetObjectItemCaseSensitive(b, "index");
    if (cJSON_IsNumber(idx) && idx->valueint >= 0 && idx->valueint < MAX_BUTTONS)
      copy(s_cfg.labels[idx->valueint], sizeof s_cfg.labels[0], jstr(b, "label"));
  }
  s_cfg.quiet = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(m, "quiet"));
  copy(s_cfg.quiet_until, sizeof s_cfg.quiet_until, jstr(m, "quietUntil"));
  const cJSON *x;
  cJSON_ArrayForEach(x, cJSON_GetObjectItemCaseSensitive(m, "missed")) {
    if (s_cfg.missed_count < MAX_MISSED)
      copy(s_cfg.missed[s_cfg.missed_count], sizeof s_cfg.missed[0], jstr(x, "from"));
    s_cfg.missed_count++;
  }
  const cJSON *owner = cJSON_GetObjectItemCaseSensitive(m, "owner");
  if (cJSON_IsObject(owner)) {
    copy(s_cfg.owner_mode, sizeof s_cfg.owner_mode, jstr(owner, "mode"));
    copy(s_cfg.owner_space, sizeof s_cfg.owner_space, jstr(owner, "space"));
    copy(s_cfg.owner_person, sizeof s_cfg.owner_person, jstr(owner, "person"));
  }
  s_authed = true;
  s_conn = CONN_ONLINE;
  s_unauthorized = 0;
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
  if (strcmp(t, "pong")) ESP_LOGI("proto", "<- %s", text);

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
  } else if (!strcmp(t, "rtc.sdp")) {
    // v0: signaling only (proto.h). The caller's offer gets an answer with no media.
    const char *type = jstr(m, "type"), *call = jstr(m, "callId"), *sdp = jstr(m, "sdp");
    if (type && call && sdp && !strcmp(type, "offer") && s_phone.kind == PH_INCALL &&
        !strcmp(call, s_phone.call_id))
      proto_sdp_answer(call, sdp);
  } else if (!strncmp(t, "rtc.", 4) || !strcmp(t, "room.media")) {
    // TODO: call audio (esp-webrtc): ICE servers and candidates are ignored in v0.
  } else {
    phone_kind_t before = s_phone.kind;
    if (phone_server(&s_phone, m, emit)) {
      if (s_phone.kind == PH_INCOMING && before != PH_INCOMING) {
        copy(s_active_label, sizeof s_active_label, s_phone.from);
        menu_close(&s_menu);
      }
      // The party that placed the call sends the SDP offer once it's connecting.
      if (before == PH_DIALING && s_phone.kind == PH_INCALL && !s_phone.connected)
        proto_sdp_offer(s_phone.call_id);
      if (s_phone.kind == PH_VOICEMAIL)
        ESP_LOGI(TAG, "voicemail offered for %s: not recorded in v0", s_phone.from);
    }
  }
done:
  cJSON_Delete(m);
}

// --- inputs ------------------------------------------------------------------------------

static void on_key(int index) {
  int64_t now = now_ms();
  signals_beep(BEEP_KEY);
  menu_screen_t was = s_menu.screen;
  // MENU opens the menu when nothing is going on (in a call it is TODO: hold/transfer).
  bool menu_ok = s_phone.kind == PH_IDLE || s_phone.kind == PH_OFFHOOK;
  if ((was != MENU_CLOSED || (index == KEY_MENU_INDEX && menu_ok)) && menu_key(&s_menu, index, now)) {
    ESP_LOGI(TAG, "MENU %s", menu_screen_name(s_menu.screen));
    if (s_menu.screen == MENU_ABOUT) {
      const char *const *w = identity_fingerprint();
      ESP_LOGI(TAG, "ABOUT fw=%s words=%s %s %s %s", FW_VERSION, w[0], w[1], w[2], w[3]);
    }
    return;
  }
  if (index >= 10) return;  // MENU/BACK outside the menu
  if (!s_authed) {
    ESP_LOGI(TAG, "key %d: not signed in yet", index);
    return;
  }
  phone_kind_t before = s_phone.kind;
  phone_button(&s_phone, index, emit);
  if (before == PH_OFFHOOK && s_phone.kind == PH_DIALING)
    copy(s_active_label, sizeof s_active_label, s_cfg.labels[index]);
}

static void on_hook(bool up) {
  s_hook_up = up;
  if (s_menu.screen != MENU_CLOSED) menu_close(&s_menu);
  phone_hook(&s_phone, up, emit);
}

// --- main loop ---------------------------------------------------------------------------

static void tick(void) {
  int64_t now = now_ms();
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
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    err = nvs_flash_init();
  }
  ESP_ERROR_CHECK(err);
  s_queue = xQueueCreate(32, sizeof(app_event_t));
  #if CONFIG_OLP_SIM
  ESP_LOGI(TAG, "Open Lounge Phone firmware %s (simulator build)", FW_VERSION);
#else
  ESP_LOGI(TAG, "Open Lounge Phone firmware %s", FW_VERSION);
#endif
  phone_init(&s_phone);

  signals_start();
#if CONFIG_OLP_SIM
  display_start(&display_ili9341_sim);
#else
  display_start(&display_epd_ssd1680);
#endif
  net_start();       // starts the radio: esp_fill_random is truly random from here on
  identity_init();   // loads or generates the device key
  codec_init();
  input_start();
  console_start();
  render();

  bool started = false;
  for (;;) {
    app_event_t ev;
    if (xQueueReceive(s_queue, &ev, pdMS_TO_TICKS(100)) == pdTRUE) {
      switch (ev.type) {
        case EV_KEY: on_key(ev.a); break;
        case EV_HOOK: on_hook(ev.a); break;
        case EV_JACK: break;  // TODO: mute the earpiece path when unplugged (audio)
        case EV_WIFI_UP:
          if (!started) {
            started = true;
            open_socket();
          }
          break;
        case EV_WIFI_DOWN:
          if (!s_ws_open) s_conn = CONN_OFFLINE;
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
          if (started) open_socket();
          break;
      }
    }
    tick();
    render();
  }
}
