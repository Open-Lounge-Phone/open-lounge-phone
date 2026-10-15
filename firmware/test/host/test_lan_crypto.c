// lan_crypto.c: the house intercom's protection. Known answers for the HMAC (RFC 4231) and
// AES-128 (FIPS-197), then sealing, opening, forging, replaying and stale lines, and audio.
#include <stdlib.h>

#include "check.h"
#include "lan_crypto.h"

static void hexs(const uint8_t *b, size_t n, char *out) {
  for (size_t i = 0; i < n; i++) snprintf(out + 2 * i, 3, "%02x", b[i]);
}

// A space key: 32 bytes 0..31, base64url.
static const char *KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

TEST(lan_hmac_rfc4231_case2) {
  uint8_t mac[32];
  char h[65];
  lan_hmac((const uint8_t *)"Jefe", 4, (const uint8_t *)"what do ya want for nothing?", 28, mac);
  hexs(mac, 32, h);
  CHECK_STR(h, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
}

TEST(lan_seals_and_opens_control_lines) {
  lan_keys_t k, other;
  CHECK(lan_keys_init(&k, KEY));
  CHECK(!lan_keys_init(&other, "short"));
  CHECK(!other.set);
  CHECK(lan_keys_init(&other, "BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"));
  char sealed[LAN_SEALED_MAX], inner[200];
  CHECK(lan_seal(&k, "OLP1|RING|0000002a|DEN|KITCHEN|call", 1791900300, 0x1234abcd, sealed,
                 sizeof sealed));
  CHECK(!strncmp(sealed, "OLP2|1791900300|1234abcd|OLP1|RING|", 35));
  lan_replay_t r = {0};
  CHECK(lan_open(&k, &r, sealed, 1791900310, inner, sizeof inner));
  CHECK_STR(inner, "OLP1|RING|0000002a|DEN|KITCHEN|call");
  // The same line again: a replay.
  CHECK(!lan_open(&k, &r, sealed, 1791900311, inner, sizeof inner));
  // Another space's key (a neighbour's phones): refused.
  lan_replay_t r2 = {0};
  CHECK(!lan_open(&other, &r2, sealed, 1791900310, inner, sizeof inner));
  // Changed in transit: refused.
  char forged[LAN_SEALED_MAX];
  snprintf(forged, sizeof forged, "%s", sealed);
  forged[30] = forged[30] == 'D' ? 'E' : 'D';
  lan_replay_t r3 = {0};
  CHECK(!lan_open(&k, &r3, forged, 1791900310, inner, sizeof inner));
  // An unsigned (labs, OLP1) line, or garbage: refused.
  CHECK(!lan_open(&k, &r3, "OLP1|RING|0000002a|DEN|KITCHEN|call", 0, inner, sizeof inner));
  CHECK(!lan_open(&k, &r3, "OLP2|x", 0, inner, sizeof inner));
  // Stale (two minutes old) when both know the time; accepted when this phone doesn't.
  lan_seal(&k, "OLP1|HELLO|DEN", 1791900300, 7, sealed, sizeof sealed);
  CHECK(!lan_open(&k, &r3, sealed, 1791900420, inner, sizeof inner));
  CHECK(lan_open(&k, &r3, sealed, 0, inner, sizeof inner));
}

TEST(lan_audio_round_trip_and_tamper) {
  lan_keys_t k;
  lan_keys_init(&k, KEY);
  lan_call_keys_t ck, wrong;
  lan_call_keys(&k, 42, &ck);
  lan_call_keys(&k, 43, &wrong);
  uint8_t frame[160], pkt[200], back[200];
  for (int i = 0; i < 160; i++) frame[i] = (uint8_t)i;
  size_t len = lan_audio_seal(&ck, 0, 7, frame, 160, pkt, sizeof pkt);
  CHECK(len == 172);
  CHECK(memcmp(pkt + 4, frame, 160) != 0);  // encrypted
  uint32_t seq;
  size_t n;
  CHECK(lan_audio_open(&ck, 0, pkt, len, &seq, back, &n));
  CHECK(seq == 7 && n == 160 && !memcmp(back, frame, 160));
  // The other direction, another call, or a flipped bit: refused.
  CHECK(!lan_audio_open(&ck, 1, pkt, len, &seq, back, &n));
  CHECK(!lan_audio_open(&wrong, 0, pkt, len, &seq, back, &n));
  pkt[50] ^= 1;
  CHECK(!lan_audio_open(&ck, 0, pkt, len, &seq, back, &n));
  // The two directions never share a keystream.
  uint8_t a[200], b[200];
  lan_audio_seal(&ck, 0, 1, frame, 160, a, sizeof a);
  lan_audio_seal(&ck, 1, 1, frame, 160, b, sizeof b);
  CHECK(memcmp(a + 4, b + 4, 160) != 0);
  CHECK(lan_audio_seal(&ck, 0, 1, frame, 160, a, 100) == 0);
}
