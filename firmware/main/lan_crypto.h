// The house intercom's protection (docs/phone-ux.md "House intercom"). The space's intercom key
// (32 bytes, from the server's config) makes two keys: one for an HMAC-SHA256 on every control
// line (with the time and a one-time number, against forging and replaying), one that makes each
// call's audio keys (AES-128-CTR, and a truncated HMAC on every packet). Uses mbedtls (the
// phone's hardware SHA and AES); host-tested with the same sources.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define LAN_SEALED_MAX 256  // a sealed control line, with its terminating NUL
#define LAN_AUDIO_OVERHEAD 12  // 4-byte sequence number + 8-byte tag around each frame
#define LAN_MAX_AGE_S 60       // control lines older (or newer) than this are refused

typedef struct {
  bool set;
  uint8_t ctl[32];  // HMAC key for control lines
  uint8_t aud[32];  // makes each call's audio keys
} lan_keys_t;

/** One call's audio keys (lan_call_keys). */
typedef struct {
  uint32_t call;
  uint8_t enc[16];  // AES-128
  uint8_t mac[32];
} lan_call_keys_t;

/** One-time numbers already seen (the last 32). */
typedef struct {
  uint32_t seen[32];
  int next;
} lan_replay_t;

void lan_hmac(const uint8_t *key, size_t klen, const uint8_t *msg, size_t n, uint8_t out[32]);
/** The space's key (base64url, 32 bytes) → the intercom's keys. False (and unset) if it isn't. */
bool lan_keys_init(lan_keys_t *k, const char *b64url);
/** `OLP2|<ts>|<nonce>|<inner>|<tag>`; `ts` = seconds since the epoch (0 = the clock isn't set). */
bool lan_seal(const lan_keys_t *k, const char *inner, uint32_t ts, uint32_t nonce, char *out,
              size_t n);
/**
 * The inner line of a sealed one, if it's genuine (the tag checks), fresh (within LAN_MAX_AGE_S
 * of `now_s` when both sides know the time) and its one-time number wasn't seen before.
 */
bool lan_open(const lan_keys_t *k, lan_replay_t *r, const char *sealed, uint32_t now_s,
              char *inner, size_t n);

void lan_call_keys(const lan_keys_t *k, uint32_t call, lan_call_keys_t *out);
/** One frame: [seq][AES-CTR of the frame][tag]; dir 0 = the caller's, 1 = the callee's. Returns
 * the packet's length (0 if `cap` is too small). */
size_t lan_audio_seal(const lan_call_keys_t *ck, int dir, uint32_t seq, const uint8_t *frame,
                      size_t n, uint8_t *out, size_t cap);
/** The frame of a packet from the other direction `dir`, if its tag checks. */
bool lan_audio_open(const lan_call_keys_t *ck, int dir, const uint8_t *pkt, size_t len,
                    uint32_t *seq, uint8_t *frame, size_t *n);
