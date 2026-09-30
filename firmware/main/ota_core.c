#include "ota_core.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *copy_str(const cJSON *o, const char *key, char *out, size_t n) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
  if (!cJSON_IsString(v)) return "missing";
  size_t len = strlen(v->valuestring);
  if (len == 0 || len >= n) return "bad length";
  for (size_t i = 0; i < len; i++)
    if ((unsigned char)v->valuestring[i] < 0x20) return "control character";  // no \n games
  memcpy(out, v->valuestring, len + 1);
  return NULL;
}

static bool is_version(const char *v) {
  // MAJOR.MINOR.PATCH[-suffix], digits and dots, then [A-Za-z0-9.-]
  int dots = 0;
  const char *p = v;
  if (!isdigit((unsigned char)*p)) return false;
  for (; *p && *p != '-'; p++) {
    if (*p == '.') {
      dots++;
      if (!isdigit((unsigned char)p[1])) return false;
    } else if (!isdigit((unsigned char)*p)) {
      return false;
    }
  }
  if (dots != 2) return false;
  if (*p == '-') {
    if (!p[1]) return false;
    for (p++; *p; p++)
      if (!isalnum((unsigned char)*p) && *p != '.' && *p != '-') return false;
  }
  return true;
}

const char *ota_manifest_parse(const char *json, ota_manifest_t *m) {
  memset(m, 0, sizeof *m);
  cJSON *j = cJSON_Parse(json);
  if (!cJSON_IsObject(j)) {
    cJSON_Delete(j);
    return "not JSON";
  }
  const char *err = NULL;
  if (copy_str(j, "board", m->board, sizeof m->board))
    err = "bad board";
  else if (copy_str(j, "version", m->version, sizeof m->version) || !is_version(m->version))
    err = "bad version";
  else if (copy_str(j, "url", m->url, sizeof m->url) || strncmp(m->url, "https://", 8))
    err = "bad url (https only)";
  else if (copy_str(j, "sha256", m->sha256, sizeof m->sha256) || strlen(m->sha256) != 64)
    err = "bad sha256";
  else if (copy_str(j, "signature", m->signature, sizeof m->signature))
    err = "bad signature field";
  if (!err) {
    for (int i = 0; i < 64; i++) {
      char c = (char)tolower((unsigned char)m->sha256[i]);
      if (!isxdigit((unsigned char)c)) err = "bad sha256";
      m->sha256[i] = c;
    }
    const cJSON *size = cJSON_GetObjectItemCaseSensitive(j, "size");
    if (!cJSON_IsNumber(size) || size->valuedouble < 1024 || size->valuedouble > 16 * 1024 * 1024 ||
        size->valuedouble != (double)(uint32_t)size->valuedouble)
      err = "bad size";
    else
      m->size = (uint32_t)size->valuedouble;
  }
  cJSON_Delete(j);
  return err;
}

int ota_manifest_signed_text(const ota_manifest_t *m, char *out, size_t n) {
  int len = snprintf(out, n, "olp-ota-v1\n%s\n%s\n%s\n%s\n%lu\n", m->board, m->version, m->url,
                     m->sha256, (unsigned long)m->size);
  return len < 0 || (size_t)len >= n ? -1 : len;
}

const char *ota_manifest_applies(const ota_manifest_t *m, const char *board, const char *running) {
  if (strcmp(m->board, board)) return "for another board";
  if (ota_version_cmp(m->version, running) <= 0) return "up to date";
  return NULL;
}

int ota_version_cmp(const char *a, const char *b) {
  for (int part = 0; part < 3; part++) {
    long x = strtol(a, (char **)&a, 10), y = strtol(b, (char **)&b, 10);
    if (x != y) return x < y ? -1 : 1;
    if (*a == '.') a++;
    if (*b == '.') b++;
  }
  // Same numbers: a pre-release ("-rc1", "-test") sorts before the release.
  bool pa = *a == '-', pb = *b == '-';
  if (pa != pb) return pa ? -1 : 1;
  return pa ? strcmp(a, b) : 0;
}

bool ota_may_install(const ota_ctx_t *c) {
  if (!c->on_hook || !c->idle || c->idle_ms < OTA_IDLE_MS) return false;
  if (!c->night_only) return true;
  if (c->local_minute < 0) return false;  // no clock yet: wait
  return c->local_minute >= OTA_NIGHT_START && c->local_minute < OTA_NIGHT_END;
}
