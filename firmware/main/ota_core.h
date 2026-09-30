// Over-the-air updates, the pure parts: the release manifest (parse + the exact bytes that are
// signed), version order, and when an update may install. No ESP-IDF; host-tested. ota.c does the
// downloading, verifying and flashing.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "cJSON.h"

#define OTA_URL_LEN 256

/**
 * firmware-manifest.json (README "Updates": the fw-stable release, never /releases/latest):
 *   {"board":"minimal-revA","version":"0.4.0","url":"https://…/fw-v0.4.0/openloungephone-0.4.0.bin",
 *    "size":1234567,"sha256":"<64 hex>","signature":"<base64 RSA-PSS-SHA256>"}
 * The signature covers ota_manifest_signed_text():
 *   "olp-ota-v1\n<board>\n<version>\n<url>\n<sha256>\n<size>\n"
 */
typedef struct {
  char board[32];       // the board this image is for (CONFIG_OLP_BOARD_ID)
  char version[32];
  char url[OTA_URL_LEN];
  uint32_t size;
  char sha256[65];      // lowercase hex
  char signature[600];  // base64 (RSA-3072 = 384 bytes → 512 characters)
} ota_manifest_t;

/** Parses and checks the manifest's shape. NULL on success, else what is wrong. */
const char *ota_manifest_parse(const char *json, ota_manifest_t *m);
/** The text the release key signs. Returns its length (or -1 if it doesn't fit). */
int ota_manifest_signed_text(const ota_manifest_t *m, char *out, size_t n);

/**
 * After the signature checked out: is this an update for this phone? NULL = install it; else why
 * not ("up to date" means an older or the same version).
 */
const char *ota_manifest_applies(const ota_manifest_t *m, const char *board, const char *running);

/** Compares "MAJOR.MINOR.PATCH" (a "-suffix" sorts before the plain version). <0, 0, >0. */
int ota_version_cmp(const char *a, const char *b);

// --- when to install ------------------------------------------------------------------------

#define OTA_IDLE_MS (10 * 60 * 1000)  // hung up and untouched this long
#define OTA_NIGHT_START 120           // 02:00 local
#define OTA_NIGHT_END 300             // 05:00 local

typedef struct {
  bool on_hook;         // handset down
  bool idle;            // no call, ringing, menu or setup going on
  int64_t idle_ms;      // how long it has been both
  int local_minute;     // minutes since local midnight, or -1 if the time isn't known
  bool night_only;      // the default; false = any time (Kconfig)
} ota_ctx_t;

/** An automatic update may install now. (MENU → Update now only needs no call going on.) */
bool ota_may_install(const ota_ctx_t *c);
