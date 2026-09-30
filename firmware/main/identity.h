// The device key (P-256, mbedTLS) and the phone's paired identity, in NVS.
// TODO: encrypted NVS (flash encryption + NVS encryption keys).
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

extern const char *const FINGERPRINT_WORDS[256];

void identity_init(void);
/** Raw public key as base64url (65-byte uncompressed SEC1 point). */
const char *identity_public_key_b64(void);
/** The four fingerprint words (lowercase). */
const char *const *identity_fingerprint(void);
/** Signs the raw nonce bytes: ECDSA P-256 / SHA-256, r‖s, base64url into `out` (≥ 90 bytes). */
bool identity_sign_b64(const uint8_t *msg, size_t len, char *out, size_t out_len);
/** Paired device id ("" when unpaired). */
const char *identity_device_id(void);
void identity_set_device_id(const char *id);
/** Erase the device key, id and settings (keeps Wi-Fi and the server). Call esp_restart() after. */
void identity_wipe(void);

/** base64url helpers (no padding). Return length or -1. */
int b64url_encode(const uint8_t *in, size_t len, char *out, size_t out_len);
int b64url_decode(const char *in, uint8_t *out, size_t out_len);
