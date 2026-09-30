#include "check.h"
#include "ice.h"

// The shape Cloudflare TURN returns (generate-ice-servers), minus the port-53 URLs the server drops.
static const char *CF =
    "[{\"urls\":[\"stun:stun.cloudflare.com:3478\"]},"
    "{\"urls\":[\"turn:turn.cloudflare.com:3478?transport=udp\","
    "\"turn:turn.cloudflare.com:3478?transport=tcp\",\"turns:turn.cloudflare.com:5349?transport=tcp\","
    "\"turn:turn.cloudflare.com:80?transport=tcp\",\"turns:turn.cloudflare.com:443?transport=tcp\"],"
    "\"username\":\"u123\",\"credential\":\"secret\"}]";

TEST(ice_picks_one_of_each_kind) {
  cJSON *j = cJSON_Parse(CF);
  ice_server_t s[ICE_MAX];
  int n = ice_pick(j, ICE_ALL, true, s, ICE_MAX);
  CHECK(n == 3);
  CHECK_STR(s[0].url, "stun:stun.cloudflare.com:3478");
  CHECK_STR(s[0].user, "");
  CHECK_STR(s[1].url, "turn:turn.cloudflare.com:3478?transport=udp");
  CHECK_STR(s[1].user, "u123");
  CHECK_STR(s[1].cred, "secret");
  CHECK_STR(s[2].url, "turns:turn.cloudflare.com:443?transport=tcp");  // TLS on 443 first
  cJSON_Delete(j);
}

TEST(ice_plain_tcp_when_tls_not_preferred) {
  cJSON *j = cJSON_Parse(CF);
  ice_server_t s[ICE_MAX];
  int n = ice_pick(j, ICE_ALL, false, s, ICE_MAX);
  CHECK(n == 3);
  CHECK_STR(s[2].url, "turn:turn.cloudflare.com:80?transport=tcp");
  cJSON_Delete(j);
}

TEST(ice_modes_filter) {
  cJSON *j = cJSON_Parse(CF);
  ice_server_t s[ICE_MAX];
  int n = ice_pick(j, ICE_TLS, false, s, ICE_MAX);
  CHECK(n == 1);
  CHECK_STR(s[0].url, "turns:turn.cloudflare.com:443?transport=tcp");
  n = ice_pick(j, ICE_TCP, true, s, ICE_MAX);  // plain TCP even if TLS is preferred
  CHECK(n == 1);
  CHECK_STR(s[0].url, "turn:turn.cloudflare.com:80?transport=tcp");
  n = ice_pick(j, ICE_UDP, true, s, ICE_MAX);
  CHECK(n == 2);
  CHECK_STR(s[1].url, "turn:turn.cloudflare.com:3478?transport=udp");
  cJSON_Delete(j);
}

TEST(ice_stun_only_and_string_urls) {
  // The STUN-only fallback (no TURN key): `urls` may be a plain string.
  cJSON *j = cJSON_Parse("[{\"urls\":\"stun:stun.cloudflare.com:3478\"},{\"urls\":\"bogus:x\"}]");
  ice_server_t s[ICE_MAX];
  CHECK(ice_pick(j, ICE_ALL, true, s, ICE_MAX) == 1);
  CHECK_STR(s[0].url, "stun:stun.cloudflare.com:3478");
  CHECK(ice_pick(j, ICE_TCP, true, s, ICE_MAX) == 0);
  cJSON_Delete(j);
}

TEST(ice_ignores_garbage) {
  cJSON *j = cJSON_Parse("[1,{\"urls\":[2,null]},{\"nourls\":true}]");
  ice_server_t s[ICE_MAX];
  CHECK(ice_pick(j, ICE_ALL, true, s, ICE_MAX) == 0);
  CHECK(ice_pick(NULL, ICE_ALL, true, s, ICE_MAX) == 0);
  cJSON_Delete(j);
}

TEST(ice_respects_max) {
  cJSON *j = cJSON_Parse(CF);
  ice_server_t s[1];
  CHECK(ice_pick(j, ICE_ALL, true, s, 1) == 1);
  cJSON_Delete(j);
}
