#include "lan_crypto.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mbedtls/aes.h"
#include "mbedtls/sha256.h"

void lan_hmac(const uint8_t *key, size_t klen, const uint8_t *msg, size_t n, uint8_t out[32]) {
  uint8_t k0[64] = {0}, pad[64], inner[32];
  if (klen > 64) mbedtls_sha256(key, klen, k0, 0);
  else memcpy(k0, key, klen);
  mbedtls_sha256_context c;
  for (int i = 0; i < 64; i++) pad[i] = k0[i] ^ 0x36;
  mbedtls_sha256_init(&c);
  mbedtls_sha256_starts(&c, 0);
  mbedtls_sha256_update(&c, pad, 64);
  mbedtls_sha256_update(&c, msg, n);
  mbedtls_sha256_finish(&c, inner);
  for (int i = 0; i < 64; i++) pad[i] = k0[i] ^ 0x5c;
  mbedtls_sha256_starts(&c, 0);
  mbedtls_sha256_update(&c, pad, 64);
  mbedtls_sha256_update(&c, inner, 32);
  mbedtls_sha256_finish(&c, out);
  mbedtls_sha256_free(&c);
}

static int b64v(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '-') return 62;
  if (c == '_') return 63;
  return -1;
}

static void derive(const uint8_t key[32], const char *label, uint8_t out[32]) {
  lan_hmac(key, 32, (const uint8_t *)label, strlen(label), out);
}

bool lan_keys_init(lan_keys_t *k, const char *s) {
  memset(k, 0, sizeof *k);
  if (!s || strlen(s) != 43) return false;
  uint8_t raw[33];
  uint32_t acc = 0;
  int bits = 0, n = 0;
  for (const char *p = s; *p; p++) {
    int v = b64v(*p);
    if (v < 0) return false;
    acc = (acc << 6) | (uint32_t)v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (n < 33) raw[n++] = (uint8_t)(acc >> bits);
    }
  }
  if (n != 32) return false;
  derive(raw, "olp-intercom-control", k->ctl);
  derive(raw, "olp-intercom-audio", k->aud);
  memset(raw, 0, sizeof raw);
  k->set = true;
  return true;
}

static void hex(const uint8_t *b, size_t n, char *out) {
  static const char *d = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) {
    out[2 * i] = d[b[i] >> 4];
    out[2 * i + 1] = d[b[i] & 15];
  }
  out[2 * n] = '\0';
}

/** The tag of `OLP2|ts|nonce|inner` (everything before the last `|`). */
static void tag_of(const lan_keys_t *k, const char *body, size_t len, char out[33]) {
  uint8_t mac[32];
  lan_hmac(k->ctl, 32, (const uint8_t *)body, len, mac);
  hex(mac, 16, out);
}

bool lan_seal(const lan_keys_t *k, const char *inner, uint32_t ts, uint32_t nonce, char *out,
              size_t n) {
  if (!k->set || !inner) return false;
  char body[LAN_SEALED_MAX];
  int len = snprintf(body, sizeof body, "OLP2|%lu|%08lx|%s", (unsigned long)ts,
                     (unsigned long)nonce, inner);
  if (len < 0 || (size_t)len >= sizeof body) return false;
  char tag[33];
  tag_of(k, body, (size_t)len, tag);
  int total = snprintf(out, n, "%s|%s", body, tag);
  return total > 0 && (size_t)total < n;
}

/** Constant-time comparison of two equal-length strings. */
static bool same(const char *a, const char *b, size_t n) {
  unsigned diff = 0;
  for (size_t i = 0; i < n; i++) diff |= (unsigned)(a[i] ^ b[i]);
  return diff == 0;
}

bool lan_open(const lan_keys_t *k, lan_replay_t *r, const char *sealed, uint32_t now_s,
              char *inner, size_t n) {
  if (!k->set || !sealed || strncmp(sealed, "OLP2|", 5)) return false;
  const char *bar = strrchr(sealed, '|');
  size_t body = (size_t)(bar - sealed);
  if (strlen(bar + 1) != 32) return false;
  char tag[33];
  tag_of(k, sealed, body, tag);
  if (!same(tag, bar + 1, 32)) return false;
  // OLP2|ts|nonce|inner
  char *end;
  unsigned long ts = strtoul(sealed + 5, &end, 10);
  if (*end != '|') return false;
  unsigned long nonce = strtoul(end + 1, &end, 16);
  if (*end != '|') return false;
  const char *in = end + 1;
  if (now_s && ts) {
    long d = (long)now_s - (long)ts;
    if (d > LAN_MAX_AGE_S || d < -LAN_MAX_AGE_S) return false;
  }
  for (int i = 0; i < 32; i++)
    if (r->seen[i] == (uint32_t)nonce && nonce) return false;
  r->seen[r->next] = (uint32_t)nonce;
  r->next = (r->next + 1) % 32;
  size_t len = (size_t)(bar - in);
  if (len >= n) return false;
  memcpy(inner, in, len);
  inner[len] = '\0';
  return true;
}

static void be32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)(v >> 24);
  p[1] = (uint8_t)(v >> 16);
  p[2] = (uint8_t)(v >> 8);
  p[3] = (uint8_t)v;
}

static uint32_t rd32(const uint8_t *p) {
  return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3];
}

void lan_call_keys(const lan_keys_t *k, uint32_t call, lan_call_keys_t *out) {
  uint8_t msg[8], h[32];
  memcpy(msg, "enc:", 4);
  be32(msg + 4, call);
  lan_hmac(k->aud, 32, msg, 8, h);
  memcpy(out->enc, h, 16);
  memcpy(msg, "mac:", 4);
  lan_hmac(k->aud, 32, msg, 8, out->mac);
  out->call = call;
}

/** AES-128-CTR of `in` (the same both ways), counter block [call][dir][0 0 0][seq][0 0 0 0]. */
static void ctr(const lan_call_keys_t *ck, int dir, uint32_t seq, const uint8_t *in, uint8_t *out,
                size_t n) {
  uint8_t iv[16] = {0}, block[16];
  size_t off = 0;
  be32(iv, ck->call);
  iv[4] = (uint8_t)dir;
  be32(iv + 8, seq);
  mbedtls_aes_context aes;
  mbedtls_aes_init(&aes);
  mbedtls_aes_setkey_enc(&aes, ck->enc, 128);
  mbedtls_aes_crypt_ctr(&aes, n, &off, iv, block, in, out);
  mbedtls_aes_free(&aes);
}

/** The packet's tag: HMAC(mac, dir || seq || ciphertext), its first 8 bytes. */
static void audio_tag(const lan_call_keys_t *ck, int dir, const uint8_t *pkt, size_t len,
                      uint8_t out[8]) {
  uint8_t buf[1 + 4 + 512], mac[32];
  if (len > 4 + 512) len = 4 + 512;
  buf[0] = (uint8_t)dir;
  memcpy(buf + 1, pkt, len);
  lan_hmac(ck->mac, 32, buf, 1 + len, mac);
  memcpy(out, mac, 8);
}

size_t lan_audio_seal(const lan_call_keys_t *ck, int dir, uint32_t seq, const uint8_t *frame,
                      size_t n, uint8_t *out, size_t cap) {
  if (n > 512 || cap < n + LAN_AUDIO_OVERHEAD) return 0;
  be32(out, seq);
  ctr(ck, dir, seq, frame, out + 4, n);
  audio_tag(ck, dir, out, 4 + n, out + 4 + n);
  return n + LAN_AUDIO_OVERHEAD;
}

bool lan_audio_open(const lan_call_keys_t *ck, int dir, const uint8_t *pkt, size_t len,
                    uint32_t *seq, uint8_t *frame, size_t *n) {
  if (len <= LAN_AUDIO_OVERHEAD || len - LAN_AUDIO_OVERHEAD > 512) return false;
  size_t body = len - LAN_AUDIO_OVERHEAD;
  uint8_t tag[8];
  audio_tag(ck, dir, pkt, 4 + body, tag);
  unsigned diff = 0;
  for (int i = 0; i < 8; i++) diff |= (unsigned)(tag[i] ^ pkt[4 + body + i]);
  if (diff) return false;
  *seq = rd32(pkt);
  ctr(ck, dir, *seq, pkt + 4, frame, body);
  *n = body;
  return true;
}
