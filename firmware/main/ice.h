// ICE servers from `rtc.config` → the short list esp_peer can use. Pure (cJSON only), unit-tested
// on the host. esp_peer takes one STUN server, one TURN server over UDP and one over TCP/TLS
// ("Skip TURN server … for only support one"), so this picks one of each.
#pragma once
#include <stdbool.h>
#include "cJSON.h"

#define ICE_MAX 3
#define ICE_URL_LEN 160
#define ICE_CRED_LEN 200

typedef struct {
  char url[ICE_URL_LEN];
  char user[ICE_CRED_LEN];
  char cred[ICE_CRED_LEN];
} ice_server_t;

typedef enum {
  ICE_ALL,       // STUN + TURN/UDP + TURN/TCP-or-TLS (the default)
  ICE_UDP,       // STUN + TURN/UDP only
  ICE_TCP,       // TURN over plain TCP only (relay-only; for networks that block UDP)
  ICE_TLS,       // TURN over TLS only (relay-only; turns:, 443 first)
} ice_mode_t;

/**
 * Picks at most one STUN, one TURN/UDP and one TURN/TCP-or-TLS URL from `ice_servers` (the
 * `iceServers` array of `rtc.config`). With `prefer_tls` the TCP slot takes a `turns:` URL on
 * port 443 first (passes most firewalls), else plain `turn:?transport=tcp`. Returns the count.
 */
int ice_pick(const cJSON *ice_servers, ice_mode_t mode, bool prefer_tls, ice_server_t *out, int max);
const char *ice_mode_name(ice_mode_t m);
