#include "compat.h"

#include <stdio.h>
#include <string.h>

static const char *str(const cJSON *o, const char *key) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
  return cJSON_IsString(v) ? v->valuestring : NULL;
}

/** `server.protocol.min|max`, or -1 when absent. */
static int range(const cJSON *m, const char *which) {
  const cJSON *server = cJSON_GetObjectItemCaseSensitive(m, "server");
  const cJSON *p = cJSON_GetObjectItemCaseSensitive(server, "protocol");
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(p, which);
  return cJSON_IsNumber(v) ? v->valueint : -1;
}

compat_t compat_from_message(const cJSON *m, int ours) {
  const char *t = str(m, "t");
  if (!t) return COMPAT_OK;
  int min = range(m, "min"), max = range(m, "max");
  if (!strcmp(t, "config")) {
    if (cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(m, "update"))) return COMPAT_UPDATE_NEEDED;
    if (min > ours) return COMPAT_UPDATE_NEEDED;
    return COMPAT_OK;
  }
  if (!strcmp(t, "error")) {
    const char *code = str(m, "code");
    if (!code || strcmp(code, "unsupported_version")) return COMPAT_OK;
    if (min > ours) return COMPAT_UPDATE_NEEDED;
    if (max >= 1 && max < ours) return COMPAT_SERVER_TOO_OLD;
    // A server that doesn't say: a phone in the field is most likely the one behind.
    return COMPAT_UPDATE_NEEDED;
  }
  return COMPAT_OK;
}

void compat_lines(compat_t c, char lines[2][25]) {
  snprintf(lines[0], 25, "%s", c == COMPAT_SERVER_TOO_OLD ? "SERVER TOO OLD" : "UPDATE NEEDED");
  snprintf(lines[1], 25, "%s", c == COMPAT_SERVER_TOO_OLD ? "ASK ITS OWNER" : "FOR THIS SERVER");
}
