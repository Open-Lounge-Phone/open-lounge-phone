#include "ice.h"

#include <stdio.h>
#include <string.h>

typedef enum { K_NONE, K_STUN, K_TURN_UDP, K_TURN_TCP, K_TURNS } kind_t;

static kind_t kind_of(const char *url) {
  if (!strncmp(url, "stun:", 5)) return K_STUN;
  if (!strncmp(url, "turns:", 6)) return K_TURNS;
  if (!strncmp(url, "turn:", 5)) return strstr(url, "transport=tcp") ? K_TURN_TCP : K_TURN_UDP;
  return K_NONE;
}

/** The port in `scheme:host:port[?...]`, or -1. */
static int port_of(const char *url) {
  const char *q = strchr(url, '?');
  size_t end = q ? (size_t)(q - url) : strlen(url);
  for (size_t i = end; i > 0; i--) {
    if (url[i - 1] == ':') {
      int port = 0;
      for (size_t j = i; j < end; j++) {
        if (url[j] < '0' || url[j] > '9') return -1;
        port = port * 10 + (url[j] - '0');
      }
      return port;
    }
  }
  return -1;
}

static const char *str_of(const cJSON *o, const char *key) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
  return cJSON_IsString(v) ? v->valuestring : "";
}

typedef struct {
  const cJSON *server;
  const char *url;
  int score;
} pick_t;

static void consider(pick_t *slot, const cJSON *server, const char *url, int score) {
  if (!slot->url || score > slot->score) *slot = (pick_t){server, url, score};
}

int ice_pick(const cJSON *ice_servers, ice_mode_t mode, bool prefer_tls, ice_server_t *out, int max) {
  if (mode == ICE_TCP) prefer_tls = false;
  if (mode == ICE_TLS) prefer_tls = true;
  pick_t stun = {0}, udp = {0}, tcp = {0};
  const cJSON *server;
  cJSON_ArrayForEach(server, ice_servers) {
    const cJSON *urls = cJSON_GetObjectItemCaseSensitive(server, "urls");
    const cJSON *one = NULL;
    // `urls` is a string or an array of strings.
    const cJSON *list = cJSON_IsArray(urls) ? urls : NULL;
    const cJSON *it = list ? list->child : urls;
    for (; it; it = list ? it->next : NULL) {
      one = it;
      if (!cJSON_IsString(one)) continue;
      const char *url = one->valuestring;
      if (strlen(url) >= ICE_URL_LEN) continue;
      int port = port_of(url);
      switch (kind_of(url)) {
        case K_STUN: consider(&stun, server, url, 1); break;
        case K_TURN_UDP: consider(&udp, server, url, port == 3478 ? 2 : 1); break;
        case K_TURN_TCP:
          if (mode != ICE_TLS) consider(&tcp, server, url, prefer_tls ? 1 : (port == 80 ? 3 : 2));
          break;
        case K_TURNS:
          if (mode != ICE_TCP) consider(&tcp, server, url, prefer_tls ? (port == 443 ? 4 : 3) : 0);
          break;
        default: break;
      }
      if (!list) break;
    }
  }
  pick_t *order[3] = {&stun, &udp, &tcp};
  if (mode == ICE_UDP) order[2] = NULL;
  if (mode == ICE_TCP || mode == ICE_TLS) order[0] = order[1] = NULL;
  int n = 0;
  for (int i = 0; i < 3 && n < max; i++) {
    if (!order[i] || !order[i]->url) continue;
    ice_server_t *s = &out[n++];
    snprintf(s->url, sizeof s->url, "%s", order[i]->url);
    snprintf(s->user, sizeof s->user, "%s", str_of(order[i]->server, "username"));
    snprintf(s->cred, sizeof s->cred, "%s", str_of(order[i]->server, "credential"));
  }
  return n;
}

const char *ice_mode_name(ice_mode_t m) {
  static const char *names[] = {"all", "udp", "tcp", "tls"};
  return names[m];
}
