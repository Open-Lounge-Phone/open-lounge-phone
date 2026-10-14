#include "labs_cfg.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"

static const char *ACTIONS[LA_COUNT] = {"phone", "intercom", "all", "chime", "ha", "story", "macro",
                                        "checkin", "doorbell"};
static const char *MODES[LM_COUNT] = {"phone", "intercom", "checkin", "macro", "home", "doorbell"};

const char *labs_action_name(labs_action_t a) { return a < LA_COUNT ? ACTIONS[a] : "?"; }
const char *labs_mode_name(labs_mode_t m) { return m < LM_COUNT ? MODES[m] : "?"; }

static void cpy(char *dst, size_t n, const char *src) { snprintf(dst, n, "%s", src ? src : ""); }
#define CPY(d, s) cpy((d), sizeof(d), (s))

static void upper(char *s) {
  for (; *s; s++) *s = (char)toupper((unsigned char)*s);
}

void labs_cfg_defaults(labs_cfg_t *c) {
  memset(c, 0, sizeof *c);
  CPY(c->name, "PHONE");
  c->mode = LM_PHONE;
  c->checkin_by = -1;
  CPY(c->door_label, "FRONT DOOR");
}

int labs_parse_hhmm(const char *s) {
  int h, m;
  char extra;
  if (!s || sscanf(s, "%d:%d%c", &h, &m, &extra) != 2 || h < 0 || h > 23 || m < 0 || m > 59) return -1;
  return h * 60 + m;
}

static const char *str(const cJSON *o, const char *k) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, k);
  return cJSON_IsString(v) ? v->valuestring : NULL;
}

static int lookup(const char *s, const char *const *names, int n) {
  for (int i = 0; s && i < n; i++)
    if (!strcmp(s, names[i])) return i;
  return -1;
}

/** "1".."9","0" (or a number) -> protocol index; -1 if not a digit key. */
static int key_index(const cJSON *v) {
  int d = -1;
  if (cJSON_IsNumber(v)) d = v->valueint;
  else if (cJSON_IsString(v) && strlen(v->valuestring) == 1 && isdigit((unsigned char)v->valuestring[0]))
    d = v->valuestring[0] - '0';
  if (d < 0 || d > 9) return -1;
  return d == 0 ? 9 : d - 1;
}

bool labs_cfg_parse(const char *json, const labs_cfg_t *keep, labs_cfg_t *out, char *err, size_t errlen) {
  // ~4 KB: on the heap (the settings page's task has a small stack)
  labs_cfg_t *cp = malloc(sizeof *cp);
  if (!cp) { snprintf(err, errlen, "no memory"); return false; }
#define c (*cp)
  labs_cfg_defaults(&c);
  cJSON *j = cJSON_Parse(json ? json : "");
  if (!cJSON_IsObject(j)) {
    snprintf(err, errlen, "not a JSON object");
    cJSON_Delete(j);
    free(cp);
    return false;
  }
  bool ok = true;
  if (str(j, "name") && *str(j, "name")) CPY(c.name, str(j, "name"));
  upper(c.name);
  if (str(j, "mode")) {
    int m = lookup(str(j, "mode"), MODES, LM_COUNT);
    if (m < 0) { snprintf(err, errlen, "mode: unknown '%s'", str(j, "mode")); ok = false; }
    else c.mode = (labs_mode_t)m;
  }
  const cJSON *k;
  cJSON_ArrayForEach(k, cJSON_GetObjectItemCaseSensitive(j, "keys")) {
    int idx = key_index(cJSON_GetObjectItemCaseSensitive(k, "key"));
    if (idx < 0) { snprintf(err, errlen, "keys: 'key' must be a digit 0-9"); ok = false; break; }
    int a = lookup(str(k, "action"), ACTIONS, LA_COUNT);
    if (a < 0) { snprintf(err, errlen, "key %s: unknown action", str(k, "key") ? str(k, "key") : "?"); ok = false; break; }
    labs_key_t *kk = &c.keys[idx];
    kk->action = (labs_action_t)a;
    CPY(kk->label, str(k, "label"));
    upper(kk->label);
    CPY(kk->target, str(k, "target"));
    CPY(kk->service, str(k, "service"));
    CPY(kk->url, str(k, "url"));
    if ((a == LA_INTERCOM || a == LA_HA || a == LA_MACRO) && !kk->target[0]) {
      snprintf(err, errlen, "key %d: '%s' needs a target", idx == 9 ? 0 : idx + 1, ACTIONS[a]);
      ok = false;
      break;
    }
    if (a == LA_STORY && strncmp(kk->url, "http://", 7) && strncmp(kk->url, "https://", 8)) {
      snprintf(err, errlen, "key %d: a story needs an http(s) url", idx == 9 ? 0 : idx + 1);
      ok = false;
      break;
    }
    // Room names are upper case (the intercom matches them exactly).
    if (a == LA_INTERCOM || a == LA_DOORBELL) upper(kk->target);
  }
  const cJSON *ha = cJSON_GetObjectItemCaseSensitive(j, "ha");
  if (cJSON_IsObject(ha)) {
    CPY(c.ha_url, str(ha, "url"));
    size_t l = strlen(c.ha_url);
    if (l && c.ha_url[l - 1] == '/') c.ha_url[l - 1] = '\0';
    CPY(c.ha_token, str(ha, "token"));
    CPY(c.ha_status, str(ha, "status"));
    CPY(c.ha_status_label, str(ha, "status_label"));
    upper(c.ha_status_label);
  }
  if (!c.ha_token[0] && keep) CPY(c.ha_token, keep->ha_token);   // write-only: blank keeps it
  const cJSON *ci = cJSON_GetObjectItemCaseSensitive(j, "checkin");
  if (cJSON_IsObject(ci)) {
    if (str(ci, "by") && *str(ci, "by")) {
      c.checkin_by = labs_parse_hhmm(str(ci, "by"));
      if (c.checkin_by < 0) { snprintf(err, errlen, "checkin.by: use HH:MM"); ok = false; }
    }
    const cJSON *r;
    cJSON_ArrayForEach(r, cJSON_GetObjectItemCaseSensitive(ci, "reminders")) {
      if (c.n_reminders >= LABS_REMINDERS) break;
      int at = labs_parse_hhmm(str(r, "at"));
      if (at < 0 || !str(r, "text")) { snprintf(err, errlen, "reminders: each needs at (HH:MM) and text"); ok = false; break; }
      c.reminders[c.n_reminders].at = at;
      CPY(c.reminders[c.n_reminders].text, str(r, "text"));
      upper(c.reminders[c.n_reminders].text);
      c.n_reminders++;
    }
  }
  if (str(j, "door_label") && *str(j, "door_label")) CPY(c.door_label, str(j, "door_label"));
  upper(c.door_label);
  cJSON_Delete(j);
  if (ok) *out = c;
#undef c
  free(cp);
  return ok;
}

static void hhmm(char *b, size_t n, int m) { snprintf(b, n, "%02d:%02d", m / 60, m % 60); }

char *labs_cfg_json(const labs_cfg_t *c, bool secrets) {
  cJSON *j = cJSON_CreateObject();
  cJSON_AddStringToObject(j, "name", c->name);
  cJSON_AddStringToObject(j, "mode", labs_mode_name(c->mode));
  cJSON *keys = cJSON_AddArrayToObject(j, "keys");
  for (int i = 0; i < LABS_KEYS; i++) {
    const labs_key_t *k = &c->keys[i];
    if (k->action == LA_PHONE && !k->label[0]) continue;
    cJSON *o = cJSON_CreateObject();
    char d[2] = {(char)(i == 9 ? '0' : '1' + i), 0};
    cJSON_AddStringToObject(o, "key", d);
    cJSON_AddStringToObject(o, "action", labs_action_name(k->action));
    if (k->label[0]) cJSON_AddStringToObject(o, "label", k->label);
    if (k->target[0]) cJSON_AddStringToObject(o, "target", k->target);
    if (k->service[0]) cJSON_AddStringToObject(o, "service", k->service);
    if (k->url[0]) cJSON_AddStringToObject(o, "url", k->url);
    cJSON_AddItemToArray(keys, o);
  }
  cJSON *ha = cJSON_AddObjectToObject(j, "ha");
  cJSON_AddStringToObject(ha, "url", c->ha_url);
  if (secrets) cJSON_AddStringToObject(ha, "token", c->ha_token);
  else cJSON_AddBoolToObject(ha, "token_set", c->ha_token[0] != '\0');
  cJSON_AddStringToObject(ha, "status", c->ha_status);
  cJSON_AddStringToObject(ha, "status_label", c->ha_status_label);
  cJSON *ci = cJSON_AddObjectToObject(j, "checkin");
  char b[16] = "";
  if (c->checkin_by >= 0) hhmm(b, sizeof b, c->checkin_by);
  cJSON_AddStringToObject(ci, "by", b);
  cJSON *rs = cJSON_AddArrayToObject(ci, "reminders");
  for (int i = 0; i < c->n_reminders; i++) {
    cJSON *r = cJSON_CreateObject();
    hhmm(b, sizeof b, c->reminders[i].at);
    cJSON_AddStringToObject(r, "at", b);
    cJSON_AddStringToObject(r, "text", c->reminders[i].text);
    cJSON_AddItemToArray(rs, r);
  }
  cJSON_AddStringToObject(j, "door_label", c->door_label);
  char *s = cJSON_PrintUnformatted(j);
  cJSON_Delete(j);
  return s;
}

labs_action_t labs_key_action(const labs_cfg_t *c, int index) {
  if (index < 0 || index >= LABS_KEYS) return LA_PHONE;
  labs_action_t a = c->keys[index].action;
  if (a == LA_PHONE && c->mode == LM_DOORBELL) return LA_DOORBELL;  // a door phone: any key rings
  if (a == LA_PHONE && c->mode == LM_CHECKIN && index == 0) return LA_CHECKIN;
  return a;
}

void labs_key_label(const labs_key_t *k, int index, char *out, size_t n) {
  if (k->label[0]) { snprintf(out, n, "%s", k->label); return; }
  switch (k->action) {
    case LA_INTERCOM: snprintf(out, n, "%s", k->target); break;
    case LA_ALL: snprintf(out, n, "ALL ROOMS"); break;
    case LA_CHIME: snprintf(out, n, "%s", k->target[0] ? k->target : "CHIME"); break;
    case LA_CHECKIN: snprintf(out, n, "I'M OK"); break;
    case LA_DOORBELL: snprintf(out, n, "RING"); break;
    case LA_STORY: snprintf(out, n, "STORY %d", index == 9 ? 0 : index + 1); break;
    default: out[0] = '\0';
  }
  for (char *c = out; *c; c++) *c = (char)toupper((unsigned char)*c);
}
