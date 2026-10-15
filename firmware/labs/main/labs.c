// Labs glue (see labs.h): settings in NVS, the intercom's sockets and audio, key actions (Home
// Assistant, stories, macro pad, check-in, doorbell, chime) and what the screen says.
#include "labs.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "app.h"
#include "audio.h"
#include "cJSON.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "labs_cfg.h"
#include "labs_checkin.h"
#include "labs_hid.h"
#include "labs_ic.h"
#include "labs_usb.h"
#include "labs_web.h"
#include "lwip/sockets.h"
#include "net.h"
#include "nvs.h"
#include "ota.h"
#include "signals.h"
#include "vmplay.h"

static const char *TAG = "labs";

#define PORT_CTRL 47100
#define PORT_AUDIO 47101
#define HELLO_MS 20000
#define HA_POLL_MS 60000
#define STORY_WAIT_MS 15000

bool app_emit(cJSON *m);       // main.c: to the server (false: not signed in / not sent)

static labs_cfg_t s_cfg;
static ic_t s_ic;
static checkin_t s_ci;
static int s_pin;
static char s_host[40];
static char s_note[2][41];
static int64_t s_note_until;
static char s_status[41];      // Home Assistant's status line
static char s_labels[LABS_KEYS][25];
static int s_ctrl = -1, s_audio = -1;
static volatile uint32_t s_audio_peer;   // network order
static bool s_audio_on;
static int64_t s_next_hello, s_next_poll, s_next_check;
static int s_pending_story = -1;
static int64_t s_pending_until;
static ic_state_t s_was = IC_IDLE;

// ---------------------------------------------------------------- settings

static void cfg_save(void) {
  char *j = labs_cfg_json(&s_cfg, true);
  nvs_handle_t h;
  if (j && nvs_open("labs", NVS_READWRITE, &h) == ESP_OK) {
    nvs_set_str(h, "cfg", j);
    nvs_set_blob(h, "ci", &s_ci, sizeof s_ci);
    nvs_commit(h);
    nvs_close(h);
  }
  free(j);
}

static void labels_refresh(void) {
  for (int i = 0; i < LABS_KEYS; i++) labs_key_label(&s_cfg.keys[i], i, s_labels[i], sizeof s_labels[i]);
}

static void host_from_name(void) {
  char slug[32];
  int k = 0;
  for (const char *c = s_cfg.name; *c && k < 24; c++) {
    if (isalnum((unsigned char)*c)) slug[k++] = (char)tolower((unsigned char)*c);
    else if (k && slug[k - 1] != '-') slug[k++] = '-';
  }
  while (k && slug[k - 1] == '-') k--;
  slug[k] = '\0';
  snprintf(s_host, sizeof s_host, "olp-%s", k ? slug : "phone");
}

const labs_cfg_t *labs_cfg(void) { return &s_cfg; }
const char *labs_host(void) { return s_host; }
bool labs_pin_ok(int pin) { return pin == s_pin; }
const ic_t *labs_ic(void) { return &s_ic; }

/** The settings page saved new settings: keep and use them (a new mode may need a restart). */
bool labs_cfg_set(const labs_cfg_t *c) {
  bool restart = (c->mode == LM_MACRO) != (s_cfg.mode == LM_MACRO);
  bool renamed = strcmp(c->name, s_cfg.name) != 0;
  s_cfg = *c;
  cfg_save();
  labels_refresh();
  if (renamed) {
    ic_t keep = s_ic;
    icom_init(&s_ic, s_cfg.name);
    memcpy(s_ic.peers, keep.peers, sizeof s_ic.peers);
    host_from_name();
    labs_web_rename(s_host);
    s_next_hello = 0;   // tell the other rooms the new name now
  }
  s_next_poll = 0;
  ESP_LOGI(TAG, "LABS settings saved (mode %s)%s", labs_mode_name(s_cfg.mode), restart ? ": restarting" : "");
  return restart;
}

void labs_start(void) {
  labs_cfg_defaults(&s_cfg);
  checkin_init(&s_ci);
  nvs_handle_t h;
  if (nvs_open("labs", NVS_READONLY, &h) == ESP_OK) {
    size_t len = 0;
    if (nvs_get_str(h, "cfg", NULL, &len) == ESP_OK && len > 1) {
      char *j = malloc(len);
      char err[96];
      if (j && nvs_get_str(h, "cfg", j, &len) == ESP_OK && !labs_cfg_parse(j, NULL, &s_cfg, err, sizeof err))
        ESP_LOGW(TAG, "saved settings: %s", err);
      free(j);
    }
    size_t n = sizeof s_ci;
    checkin_t ci;
    if (nvs_get_blob(h, "ci", &ci, &n) == ESP_OK && n == sizeof ci) s_ci = ci;
    nvs_close(h);
  }
  s_pin = 1000 + (int)(esp_random() % 9000);
  host_from_name();
  labels_refresh();
  icom_init(&s_ic, s_cfg.name);
  if (s_cfg.mode == LM_MACRO) labs_usb_start();
  ESP_LOGI(TAG, "LABS %s, mode %s; settings http://%s.local (PIN in MENU 5)", s_cfg.name,
           labs_mode_name(s_cfg.mode), s_host);
}

// ---------------------------------------------------------------- notes and the server

static void note(const char *a, const char *b, int64_t now) {
  snprintf(s_note[0], sizeof s_note[0], "%s", a ? a : "");
  snprintf(s_note[1], sizeof s_note[1], "%s", b ? b : "");
  s_note_until = now + 4000;
}

static void post_note(const char *a, const char *b) {
  char *d = malloc(96);
  if (!d) return;
  snprintf(d, 96, "N|%s|%s", a, b);
  app_post(EV_LABS, 0, d);
}

static bool server_send(const char *t, const char *by) {
  cJSON *m = cJSON_CreateObject();
  cJSON_AddStringToObject(m, "t", t);
  if (by) cJSON_AddStringToObject(m, "by", by);
  return app_emit(m);
}

// ---------------------------------------------------------------- the intercom's network

static void broadcast(ic_out_t *o) {
  if (s_ctrl < 0) { o->n = 0; return; }
  struct sockaddr_in to = {.sin_family = AF_INET, .sin_port = htons(PORT_CTRL),
                           .sin_addr.s_addr = htonl(INADDR_BROADCAST)};
  for (int i = 0; i < o->n; i++) {
    sendto(s_ctrl, o->lines[i], strlen(o->lines[i]), 0, (struct sockaddr *)&to, sizeof to);
    ESP_LOGI(TAG, "IC -> %s", o->lines[i]);
  }
  o->n = 0;
}

static void ctrl_task(void *arg) {
  char buf[IC_LINE];
  for (;;) {
    struct sockaddr_in from;
    socklen_t fl = sizeof from;
    int n = recvfrom(s_ctrl, buf, sizeof buf - 1, 0, (struct sockaddr *)&from, &fl);
    if (n <= 0) { vTaskDelay(pdMS_TO_TICKS(100)); continue; }
    buf[n] = '\0';
    char *d = malloc(n + 24);
    if (!d) continue;
    snprintf(d, n + 24, "M|%lu|%s", (unsigned long)from.sin_addr.s_addr, buf);
    app_post(EV_LABS, 0, d);
  }
}

static void audio_task(void *arg) {
  uint8_t buf[4 + 320];
  for (;;) {
    struct sockaddr_in from;
    socklen_t fl = sizeof from;
    int n = recvfrom(s_audio, buf, sizeof buf, 0, (struct sockaddr *)&from, &fl);
    if (n > 4 && s_audio_on && from.sin_addr.s_addr == s_audio_peer) audio_rx_ulaw(buf + 4, n - 4);
  }
}

static void audio_send(const uint8_t *ulaw, size_t n, uint32_t pts) {
  static uint32_t seq;
  uint8_t pkt[4 + 320];
  if (s_audio < 0 || !s_audio_peer || n > 320) return;
  seq++;
  memcpy(pkt, &seq, 4);
  memcpy(pkt + 4, ulaw, n);
  struct sockaddr_in to = {.sin_family = AF_INET, .sin_port = htons(PORT_AUDIO),
                           .sin_addr.s_addr = s_audio_peer};
  sendto(s_audio, pkt, 4 + n, 0, (struct sockaddr *)&to, sizeof to);
}

static int udp(int port, bool bcast) {
  int s = socket(AF_INET, SOCK_DGRAM, 0);
  if (s < 0) return -1;
  int on = 1;
  setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &on, sizeof on);
  if (bcast) setsockopt(s, SOL_SOCKET, SO_BROADCAST, &on, sizeof on);
  struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(port), .sin_addr.s_addr = htonl(INADDR_ANY)};
  if (bind(s, (struct sockaddr *)&a, sizeof a) < 0) { close(s); return -1; }
  return s;
}

void labs_net_up(void) {
  if (s_ctrl < 0) {
    s_ctrl = udp(PORT_CTRL, true);
    s_audio = udp(PORT_AUDIO, false);
    if (s_ctrl >= 0) xTaskCreate(ctrl_task, "labs_ic", 4096, NULL, 5, NULL);
    if (s_audio >= 0) xTaskCreate(audio_task, "labs_au", 3072, NULL, 6, NULL);
    ESP_LOGI(TAG, "intercom on UDP %d/%d %s", PORT_CTRL, PORT_AUDIO, s_ctrl >= 0 ? "" : "(failed)");
  }
  labs_web_start(s_host);
  s_next_hello = 0;
  s_next_poll = 0;
}

/** After any intercom change: audio, ringing, a chime. */
static void ic_sync(void) {
  bool talk = s_ic.st == IC_TALK;
  if (talk && !s_audio_on) {
    s_audio_peer = s_ic.peer_ip;
    s_audio_on = true;
    audio_call(true, audio_send);
    ESP_LOGI(TAG, "IC talking with %s", s_ic.peer);
  } else if (!talk && s_audio_on) {
    s_audio_on = false;
    s_audio_peer = 0;
    audio_call(false, NULL);
  }
  if (s_ic.chimed) {
    s_ic.chimed = false;
    signals_beep(BEEP_PAIR);
    ESP_LOGI(TAG, "IC chime [%s|%s]: beep", s_ic.note[0], s_ic.note[1]);
  }
  if (s_ic.st != s_was) {
    ESP_LOGI(TAG, "IC state %d -> %d", s_was, s_ic.st);
    s_was = s_ic.st;
  }
}

// ---------------------------------------------------------------- Home Assistant

typedef struct { char url[256]; char token[256]; char body[96]; char label[25]; bool status; } ha_job_t;

static void ha_task(void *arg) {
  ha_job_t *j = arg;
  esp_http_client_config_t cfg = {.url = j->url, .timeout_ms = 8000,
                                  .crt_bundle_attach = esp_crt_bundle_attach,
                                  .method = j->status ? HTTP_METHOD_GET : HTTP_METHOD_POST};
  esp_http_client_handle_t c = esp_http_client_init(&cfg);
  char auth[280], resp[512] = "";
  int status = -1;
  if (c) {
    snprintf(auth, sizeof auth, "Bearer %s", j->token);
    esp_http_client_set_header(c, "Authorization", auth);
    esp_http_client_set_header(c, "Content-Type", "application/json");
    if (esp_http_client_open(c, j->status ? 0 : (int)strlen(j->body)) == ESP_OK) {
      if (!j->status) esp_http_client_write(c, j->body, (int)strlen(j->body));
      esp_http_client_fetch_headers(c);
      status = esp_http_client_get_status_code(c);
      int n = esp_http_client_read(c, resp, sizeof resp - 1);
      resp[n > 0 ? n : 0] = '\0';
    }
    esp_http_client_cleanup(c);
  }
  if (j->status) {
    cJSON *r = cJSON_Parse(resp);
    const cJSON *st = cJSON_GetObjectItemCaseSensitive(r, "state");
    char *d = malloc(64);
    if (d) {
      if (status == 200 && cJSON_IsString(st))
        snprintf(d, 64, "S|%s%s%s", j->label, j->label[0] ? ": " : "", st->valuestring);
      else snprintf(d, 64, "S|HOME OFFLINE");
      for (char *p = d + 2; *p; p++) *p = (char)toupper((unsigned char)*p);
      app_post(EV_LABS, 0, d);
    }
    cJSON_Delete(r);
  } else {
    post_note(j->label, status >= 200 && status < 300 ? "DONE" : "HOME DIDN'T ANSWER");
  }
  ESP_LOGI(TAG, "HA %s -> %d", j->url, status);
  free(j);
  vTaskDelete(NULL);
}

static void ha_call(const labs_key_t *k, const char *label, int64_t now) {
  if (!s_cfg.ha_url[0] || !s_cfg.ha_token[0]) { note("SET UP HOME", "IN LABS SETTINGS", now); return; }
  ha_job_t *j = calloc(1, sizeof *j);
  if (!j) return;
  char domain[24], service[24];
  const char *svc = k->service[0] ? k->service : "scene.turn_on";
  if (sscanf(svc, "%23[^.].%23s", domain, service) != 2) { note(label, "BAD SERVICE", now); free(j); return; }
  snprintf(j->url, sizeof j->url, "%s/api/services/%s/%s", s_cfg.ha_url, domain, service);
  snprintf(j->token, sizeof j->token, "%s", s_cfg.ha_token);
  snprintf(j->body, sizeof j->body, "{\"entity_id\":\"%s\"}", k->target);
  snprintf(j->label, sizeof j->label, "%s", label);
  note(label, "...", now);
  if (xTaskCreate(ha_task, "labs_ha", 6144, j, 4, NULL) != pdPASS) free(j);
}

static void ha_poll(void) {
  if (!s_cfg.ha_url[0] || !s_cfg.ha_token[0] || !s_cfg.ha_status[0] || !net_wifi_up()) return;
  ha_job_t *j = calloc(1, sizeof *j);
  if (!j) return;
  j->status = true;
  snprintf(j->url, sizeof j->url, "%s/api/states/%s", s_cfg.ha_url, s_cfg.ha_status);
  snprintf(j->token, sizeof j->token, "%s", s_cfg.ha_token);
  snprintf(j->label, sizeof j->label, "%s", s_cfg.ha_status_label);
  if (xTaskCreate(ha_task, "labs_ha", 6144, j, 4, NULL) != pdPASS) free(j);
}

// ---------------------------------------------------------------- time for the check-in

static void today(int *day, int *minute) {
  *minute = ota_local_minute();
  long d = ota_local_day();
  *day = *minute < 0 ? -1 : (int)d;
}

// ---------------------------------------------------------------- keys and the hook

bool labs_key(int index, bool hook_up, int64_t now) {
  if (index == 11) {                                       // BACK: stop the intercom
    if (s_ic.st == IC_IDLE) return false;
    ic_out_t o = {0};
    icom_cancel(&s_ic, &o);
    broadcast(&o);
    ic_sync();
    return true;
  }
  if (index < 0 || index >= LABS_KEYS) return false;
  if (s_ic.st != IC_IDLE) return true;                     // keys wait while the intercom is busy
  int day, minute;
  today(&day, &minute);
  int rem = checkin_reminder(&s_cfg, &s_ci, day, minute);
  labs_key_t *k = &s_cfg.keys[index];
  labs_action_t a = labs_key_action(&s_cfg, index);
  if (rem >= 0 && !hook_up && a != LA_CHECKIN) {           // a reminder showing: any key = done
    checkin_ack(&s_ci, rem, day);
    cfg_save();
    note(s_cfg.reminders[rem].text, "DONE", now);
    return true;
  }
  const char *label = s_labels[index];
  ic_out_t o = {0};
  switch (a) {
    case LA_PHONE:
      return false;
    case LA_INTERCOM:
    case LA_ALL:
      if (!hook_up) { note("LIFT THE HANDSET", "THEN PRESS THE KEY", now); return true; }
      icom_call(&s_ic, a == LA_ALL ? "*" : k->target, false, esp_random(), now, &o);
      break;
    case LA_DOORBELL:
      icom_call(&s_ic, k->target[0] ? k->target : "*", true, esp_random(), now, &o);
      signals_beep(BEEP_OK);
      break;
    case LA_CHIME:
      icom_chime(&s_ic, k->target[0] ? k->target : label, &o);
      signals_beep(BEEP_PAIR);
      note(label[0] ? label : "CHIME", "SENT TO EVERY ROOM", now);
      break;
    case LA_HA:
      ha_call(k, label, now);
      return true;
    case LA_STORY:
      if (hook_up) vmplay_play_url(k->url, label, now);
      else {
        s_pending_story = index;
        s_pending_until = now + STORY_WAIT_MS;
        note(label, "LIFT THE HANDSET", now);
      }
      return true;
    case LA_MACRO: {
      hid_combo_t c;
      if (!hid_parse(k->target, &c)) note(label, "BAD KEY COMBO", now);
      else if (!labs_usb_ready()) note("MACRO PAD", s_cfg.mode == LM_MACRO ? "PLUG INTO A COMPUTER" : "SET MODE MACRO", now);
      else labs_usb_send(&c);
      return true;
    }
    case LA_CHECKIN:
      checkin_ok(&s_cfg, &s_ci, day, minute);
      cfg_save();
      server_send("checkin.ok", NULL);
      signals_beep(BEEP_OK);
      note("THANK YOU", "CHECKED IN", now);
      return true;
    default:
      return false;
  }
  broadcast(&o);
  ic_sync();
  return true;
}

bool labs_hook(bool up, int64_t now) {
  if (up && s_pending_story >= 0 && now < s_pending_until) {     // pressed a story, then lifted
    labs_key_t *k = &s_cfg.keys[s_pending_story];
    vmplay_play_url(k->url, s_labels[s_pending_story], now);
    s_pending_story = -1;
    return false;
  }
  if (s_ic.st == IC_IDLE) return false;
  ic_out_t o = {0};
  icom_hook(&s_ic, up, now, &o);
  broadcast(&o);
  ic_sync();
  return true;
}

void labs_event(int a, char *data, int64_t now) {
  if (!data) return;
  if (data[0] == 'M' && data[1] == '|') {
    char *ip = data + 2, *line = strchr(ip, '|');
    if (line) {
      *line++ = '\0';
      ESP_LOGI(TAG, "IC <- %s", line);
      ic_out_t o = {0};
      icom_msg(&s_ic, (uint32_t)strtoul(ip, NULL, 10), line, now, &o);
      broadcast(&o);
      ic_sync();
    }
  } else if (data[0] == 'N' && data[1] == '|') {
    char *b = strchr(data + 2, '|');
    if (b) *b++ = '\0';
    note(data + 2, b ? b : "", now);
  } else if (data[0] == 'S' && data[1] == '|') {
    snprintf(s_status, sizeof s_status, "%s", data + 2);
  }
  free(data);
}

void labs_tick(int64_t now) {
  ic_out_t o = {0};
  if (s_ctrl >= 0 && now >= s_next_hello) {
    s_next_hello = now + HELLO_MS;
    icom_hello(&s_ic, &o);
  }
  icom_tick(&s_ic, now, &o);
  broadcast(&o);
  ic_sync();
  if (now >= s_next_poll && net_wifi_up()) {
    s_next_poll = now + HA_POLL_MS;
    ha_poll();
  }
  if (now >= s_next_check) {
    s_next_check = now + 10000;
    int day, minute;
    today(&day, &minute);
    if (checkin_alert_pending(&s_cfg, &s_ci, day, minute)) {
      // Offline (no server connection): try again on the next check, so the alert isn't lost.
      char by[16];
      snprintf(by, sizeof by, "%02d:%02d", s_cfg.checkin_by / 60, s_cfg.checkin_by % 60);
      if (server_send("checkin.missed", by)) {
        ESP_LOGW(TAG, "CHECK-IN missed (by %s): the family was told", by);
        checkin_due_alert(&s_cfg, &s_ci, day, minute);
        cfg_save();
      } else {
        ESP_LOGW(TAG, "CHECK-IN missed (by %s): not connected, trying again", by);
      }
    }
  }
  if (s_pending_story >= 0 && now >= s_pending_until) s_pending_story = -1;
}

// ---------------------------------------------------------------- the screen

int labs_lines(char out[2][41], bool idle, bool offhook, int64_t now) {
  int n = icom_lines(&s_ic, now, out);
  if (n) return n;
  if (now < s_note_until) {
    snprintf(out[0], 41, "%s", s_note[0]);
    snprintf(out[1], 41, "%s", s_note[1]);
    return 2;
  }
  if (!idle) return 0;
  int day, minute;
  today(&day, &minute);
  if (checkin_reminder(&s_cfg, &s_ci, day, minute) >= 0 || s_cfg.mode == LM_CHECKIN) {
    n = checkin_lines(&s_cfg, &s_ci, day, minute, out);
    if (n) return n;
  }
  switch (s_cfg.mode) {
    case LM_INTERCOM: {
      int peers = icom_peer_count(&s_ic, now);
      snprintf(out[0], 41, "%s", s_cfg.name);
      if (peers) snprintf(out[1], 41, "%d ROOM%s NEARBY", peers, peers == 1 ? "" : "S");
      else snprintf(out[1], 41, "NO OTHER ROOMS YET");
      return 2;
    }
    case LM_HOME:
      snprintf(out[0], 41, "%s", s_cfg.name);
      snprintf(out[1], 41, "%s", s_status[0] ? s_status : "HOME PANEL");
      return 2;
    case LM_MACRO:
      snprintf(out[0], 41, "MACRO PAD");
      snprintf(out[1], 41, "%s", labs_usb_ready() ? "CONNECTED" : "PLUG INTO A COMPUTER");
      return 2;
    case LM_DOORBELL:
      snprintf(out[0], 41, "%s", s_cfg.door_label);
      snprintf(out[1], 41, "PRESS ANY KEY TO RING");
      return 2;
    default:
      return 0;
  }
}

const char *labs_label(int index) {
  if (index < 0 || index >= LABS_KEYS) return NULL;
  if (s_cfg.keys[index].action == LA_PHONE && s_cfg.mode != LM_DOORBELL) return NULL;
  return s_labels[index][0] ? s_labels[index] : (s_cfg.mode == LM_DOORBELL ? "RING" : NULL);
}

bool labs_busy(void) { return s_ic.st != IC_IDLE; }
bool labs_standalone(void) { return s_cfg.mode != LM_PHONE; }
bool labs_ringing(void) { return s_ic.st == IC_RINGING; }

int labs_menu_lines(char out[6][25]) {
  snprintf(out[0], 25, "LABS: %.18s", s_cfg.name);
  snprintf(out[1], 25, "%.18s.LOCAL", s_host);
  for (char *c = out[1]; *c; c++) *c = (char)toupper((unsigned char)*c);
  snprintf(out[2], 25, "SETTINGS PIN %d", s_pin);
  snprintf(out[3], 25, "MODE %s", labs_mode_name(s_cfg.mode));
  for (char *c = out[3]; *c; c++) *c = (char)toupper((unsigned char)*c);
  return 4;
}
