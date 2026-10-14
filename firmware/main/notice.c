#include "notice.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

void notice_init(notice_t *n) { memset(n, 0, sizeof *n); }

static const char *jstr(const cJSON *o, const char *k) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, k);
  return cJSON_IsString(v) ? v->valuestring : NULL;
}

/** Copies a line in capitals, at most 16 characters, plain ASCII only. */
static void line(char *out, const char *in) {
  int k = 0;
  for (const char *c = in; c && *c && k < 16; c++) {
    unsigned char ch = (unsigned char)*c;
    out[k++] = ch >= 0x20 && ch < 0x7f ? (char)toupper(ch) : '?';
  }
  out[k] = '\0';
}

bool notice_set(notice_t *n, const cJSON *msg) {
  const char *id = jstr(msg, "id");
  const cJSON *lines = cJSON_GetObjectItemCaseSensitive(msg, "lines");
  if (!id || !cJSON_IsArray(lines) || cJSON_GetArraySize(lines) < 1) return false;
  bool fresh = !n->active || strcmp(n->id, id) != 0;
  notice_init(n);
  n->active = true;
  snprintf(n->id, sizeof n->id, "%s", id);
  const cJSON *l;
  cJSON_ArrayForEach(l, lines) {
    if (n->n >= 2 || !cJSON_IsString(l)) break;
    line(n->lines[n->n++], l->valuestring);
  }
  const cJSON *audio = cJSON_GetObjectItemCaseSensitive(msg, "audio");
  const char *token = jstr(audio, "token");
  if (token && strlen(token) < sizeof n->token) {
    snprintf(n->token, sizeof n->token, "%s", token);
    const cJSON *ms = cJSON_GetObjectItemCaseSensitive(audio, "durationMs");
    n->duration_ms = cJSON_IsNumber(ms) ? ms->valueint : 0;
  }
  return fresh;
}

void notice_clear(notice_t *n, const char *id) {
  if (n->active && id && !strcmp(n->id, id)) notice_init(n);
}

int notice_lines(const notice_t *n, char out[2][41]) {
  if (!n->active || n->n < 1) return 0;
  for (int i = 0; i < n->n; i++) snprintf(out[i], 41, "%s", n->lines[i]);
  return n->n;
}

bool notice_audio_path(const notice_t *n, char *out, int size) {
  if (!n->active || !n->token[0]) return false;
  int w = snprintf(out, (size_t)size, "/api/notices/%s/audio?token=%s", n->id, n->token);
  return w > 0 && w < size;
}
