// Labs glue (see labs.h): settings in NVS, key actions (Home Assistant, stories, macro pad,
// check-in, and the house intercom's room, all-rooms, doorbell and chime keys through the phone's
// own intercom, lan.h) and what the screen says.
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
#include "labs_usb.h"
#include "labs_web.h"
#include "lan.h"
#include "net.h"
#include "nvs.h"
#include "ota.h"
#include "signals.h"
#include "vmplay.h"

static const char *TAG = "labs";

#define HA_POLL_MS 60000
#define STORY_WAIT_MS 15000

bool app_emit(cJSON *m);       // main.c: to the server (false: not signed in / not sent)

static labs_cfg_t s_cfg;
static checkin_t s_ci;
static int s_pin;
static char s_host[40];
static char s_note[2][41];
static int64_t s_note_until;
static char s_status[41];      // Home Assistant's status line
static char s_labels[LABS_KEYS][25];
static int64_t s_next_poll;
static int s_pending_story = -1;
static int64_t s_pending_until;

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

/** The settings page saved new settings: keep and use them (a new mode may need a restart). */
bool labs_cfg_set(const labs_cfg_t *c) {
  bool restart = (c->mode == LM_MACRO) != (s_cfg.mode == LM_MACRO);
  bool renamed = strcmp(c->name, s_cfg.name) != 0;
  s_cfg = *c;
  cfg_save();
  labels_refresh();
  if (renamed) {
    host_from_name();
    labs_web_rename(s_host);
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
  if (s_cfg.mode == LM_MACRO) labs_usb_start();
  ESP_LOGI(TAG, "LABS %s, mode %s; settings http://%s.local (PIN in MENU 4)", s_cfg.name,
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

// ---------------------------------------------------------------- the network

void labs_net_up(void) {
  labs_web_start(s_host);
  s_next_poll = 0;
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
  if (!s_cfg.ha_url[0] || !s_cfg.ha_token[0] || !s_cfg.ha_status[0] || !net_up()) return;
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
  if (index < 0 || index >= LABS_KEYS) return false;
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
  // The intercom keys use the phone's own house intercom (on in the app, Manage phone).
  bool lan = a == LA_INTERCOM || a == LA_ALL || a == LA_DOORBELL || a == LA_CHIME;
  if (lan && !lan_enabled()) {
    note("INTERCOM IS OFF", "TURN IT ON IN THE APP", now);
    return true;
  }
  switch (a) {
    case LA_PHONE:
      return false;
    case LA_INTERCOM:
    case LA_ALL:
      if (!hook_up) { note("LIFT THE HANDSET", "THEN PRESS THE KEY", now); return true; }
      lan_call(a == LA_ALL ? "*" : k->target, false, now);
      return true;
    case LA_DOORBELL:
      lan_call(k->target[0] ? k->target : "*", true, now);
      signals_beep(BEEP_OK);
      return true;
    case LA_CHIME:
      lan_chime(k->target[0] ? k->target : label);
      signals_beep(BEEP_PAIR);
      note(label[0] ? label : "CHIME", "SENT TO EVERY ROOM", now);
      return true;
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
}

bool labs_hook(bool up, int64_t now) {
  if (up && s_pending_story >= 0 && now < s_pending_until) {     // pressed a story, then lifted
    labs_key_t *k = &s_cfg.keys[s_pending_story];
    vmplay_play_url(k->url, s_labels[s_pending_story], now);
    s_pending_story = -1;
    return false;
  }
  return false;  // the house intercom takes its own (lan_hook, before this)
}

void labs_event(int a, char *data, int64_t now) {
  if (!data) return;
  if (data[0] == 'N' && data[1] == '|') {
    char *b = strchr(data + 2, '|');
    if (b) *b++ = '\0';
    note(data + 2, b ? b : "", now);
  } else if (data[0] == 'S' && data[1] == '|') {
    snprintf(s_status, sizeof s_status, "%s", data + 2);
  }
  free(data);
}

void labs_tick(int64_t now) {
  if (now >= s_next_poll && net_up()) {
    s_next_poll = now + HA_POLL_MS;
    ha_poll();
  }
  // The daily check-in's time is set in the app now and watched by the server (the phone's own
  // check-in); labs keeps the reminders.
  if (s_pending_story >= 0 && now >= s_pending_until) s_pending_story = -1;
}

// ---------------------------------------------------------------- the screen

int labs_lines(char out[2][41], bool idle, bool offhook, int64_t now) {
  int n;
  if (now < s_note_until) {
    snprintf(out[0], 41, "%s", s_note[0]);
    snprintf(out[1], 41, "%s", s_note[1]);
    return 2;
  }
  if (!idle) return 0;
  int day, minute;
  today(&day, &minute);
  int rem = checkin_reminder(&s_cfg, &s_ci, day, minute);
  if (rem >= 0) {  // a reminder (the check-in itself is the phone's own screen now)
    snprintf(out[0], 41, "%02d:%02d %s", s_cfg.reminders[rem].at / 60, s_cfg.reminders[rem].at % 60,
             s_cfg.reminders[rem].text);
    snprintf(out[1], 41, "PRESS A KEY: DONE");
    return 2;
  }
  switch (s_cfg.mode) {
    case LM_INTERCOM: {
      char rooms[8][25];
      int peers = lan_rooms(rooms, 8, now);
      if (!lan_enabled()) {
        snprintf(out[0], 41, "%s", s_cfg.name);
        snprintf(out[1], 41, "INTERCOM IS OFF");
        return 2;
      }
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

bool labs_standalone(void) { return s_cfg.mode != LM_PHONE; }

int labs_menu_lines(char out[6][25]) {
  snprintf(out[0], 25, "LABS: %.18s", s_cfg.name);
  snprintf(out[1], 25, "%.18s.LOCAL", s_host);
  for (char *c = out[1]; *c; c++) *c = (char)toupper((unsigned char)*c);
  snprintf(out[2], 25, "SETTINGS PIN %d", s_pin);
  snprintf(out[3], 25, "MODE %s", labs_mode_name(s_cfg.mode));
  for (char *c = out[3]; *c; c++) *c = (char)toupper((unsigned char)*c);
  return 4;
}
