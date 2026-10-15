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

/** The most remote candidates esp_peer keeps (media.c `max_candidates`): the rest are dropped. */
#define ICE_REMOTE_MAX 8

/**
 * How useful another side's candidate (`candidate:… 1 udp … 203.0.113.5 52834 typ srflx …`) is to
 * this phone, which speaks IPv4 over UDP only: 3 host, 2 server- or peer-reflexive, 1 relay,
 * 0 a host hidden behind an mDNS name (`….local`, which the phone can't look up); -1 unusable
 * (IPv6, TCP, not component 1, or not a candidate at all).
 */
int ice_cand_rank(const char *cand);
/**
 * The best `max` of `n` candidates: unusable ones never, then by rank, in their order within a
 * rank. Writes their indexes (in `cands`) to `out`, best first; returns how many.
 */
int ice_cand_pick(const char *const *cands, int n, int *out, int max);
