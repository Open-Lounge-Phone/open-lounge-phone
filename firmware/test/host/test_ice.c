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

// What Chrome trickled in a real call (addresses changed): IPv4 and IPv6 host and srflx, and a
// relay per TURN URL and transport.
static const char *CHROME[] = {
    "candidate:1 1 udp 2122260223 192.168.1.20 58866 typ host generation 0 ufrag a network-id 1",
    "candidate:2 1 udp 2122194687 2001:db8::20 58867 typ host generation 0 ufrag a network-id 2",
    "candidate:3 1 tcp 1518280447 192.168.1.20 9 typ host tcptype active generation 0",
    "candidate:4 1 tcp 1518214911 2001:db8::20 9 typ host tcptype active generation 0",
    "candidate:5 1 udp 1686052607 203.0.113.7 58866 typ srflx raddr 192.168.1.20 rport 58866",
    "candidate:6 1 udp 1685987071 2001:db8::20 58867 typ srflx raddr 2001:db8::20 rport 58867",
    "candidate:7 1 udp 41885439 198.51.100.1 51001 typ relay raddr 203.0.113.7 rport 58866",
    "candidate:8 1 udp 41819903 2001:db8:1::1 51002 typ relay raddr 2001:db8::20 rport 58867",
    "candidate:9 1 udp 25108223 198.51.100.1 51003 typ relay raddr 203.0.113.7 rport 58868",
    "candidate:10 1 udp 25042687 198.51.100.1 51004 typ relay raddr 203.0.113.7 rport 58869",
    "candidate:11 1 udp 8331007 198.51.100.1 51005 typ relay raddr 203.0.113.7 rport 58870",
    "candidate:12 1 udp 8265471 198.51.100.1 51006 typ relay raddr 203.0.113.7 rport 58871",
    "candidate:13 1 udp 41820415 198.51.100.1 51007 typ relay raddr 203.0.113.7 rport 58872",
    "candidate:14 1 udp 2122260223 4a8b8c1d-0000-4000-8000-000000000000.local 58873 typ host",
    "candidate:15 1 udp 41820414 198.51.100.1 51008 typ relay raddr 203.0.113.7 rport 58873",
    "candidate:16 1 udp 41820413 198.51.100.1 51009 typ relay raddr 203.0.113.7 rport 58874",
};

TEST(ice_ranks_remote_candidates_for_an_ipv4_udp_phone) {
  CHECK(ice_cand_rank(CHROME[0]) == 3);   // IPv4 host
  CHECK(ice_cand_rank(CHROME[1]) == -1);  // IPv6
  CHECK(ice_cand_rank(CHROME[2]) == -1);  // TCP
  CHECK(ice_cand_rank(CHROME[4]) == 2);   // srflx
  CHECK(ice_cand_rank(CHROME[6]) == 1);   // relay
  CHECK(ice_cand_rank(CHROME[13]) == 0);  // mDNS host name
  CHECK(ice_cand_rank("a=candidate:1 1 UDP 1 10.0.0.2 5000 typ prflx") == 2);
  CHECK(ice_cand_rank("candidate:1 2 udp 1 10.0.0.2 5000 typ host") == -1);  // RTCP component
  CHECK(ice_cand_rank("candidate:1 1 udp") == -1);
  CHECK(ice_cand_rank("") == -1);
  CHECK(ice_cand_rank(NULL) == -1);
}

TEST(ice_keeps_the_best_eight_remote_candidates) {
  int out[ICE_REMOTE_MAX];
  int n = ice_cand_pick(CHROME, 16, out, ICE_REMOTE_MAX);
  CHECK(n == ICE_REMOTE_MAX);
  CHECK(out[0] == 0);  // the host first
  CHECK(out[1] == 4);  // then the srflx
  // Then relays in the order they came (the IPv6 and TCP ones never), and no room left for the
  // mDNS host.
  CHECK(out[2] == 6 && out[3] == 8 && out[4] == 9 && out[5] == 10 && out[6] == 11 && out[7] == 12);
  // Fewer than the limit: every usable one, best first.
  const char *few[] = {CHROME[6], CHROME[13], CHROME[1], CHROME[0]};
  n = ice_cand_pick(few, 4, out, ICE_REMOTE_MAX);
  CHECK(n == 3 && out[0] == 3 && out[1] == 0 && out[2] == 1);
}
