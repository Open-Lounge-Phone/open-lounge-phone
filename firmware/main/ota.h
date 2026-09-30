// Over-the-air updates. A signed manifest (manifest.json on the GitHub release: version, url,
// size, sha256, RSA-PSS signature by the release key embedded in this firmware) points at the
// image; the phone checks the manifest's signature, downloads the image over HTTPS while hashing
// it, flashes the other slot, checks the hash (and, in release builds, the image's own Secure Boot
// V2 signature), and restarts into it on trial. The new firmware is marked good once it reaches
// the server; if it crashes or can't get there, the bootloader goes back to the old one.
#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef enum {
  OTA_IDLE,
  OTA_CHECKING,
  OTA_DOWNLOADING,
  OTA_RESTARTING,
} ota_state_t;

/** At boot: notes a trial boot (and arms its rollback timer) or a rollback that just happened. */
void ota_boot(void);
/** The server answered (a pairing code or a config): a trial firmware is good. */
void ota_server_ok(void);
/** SNTP for the overnight window (after the network is up). */
void ota_time_start(void);
/** The space's UTC offset from `config` (minutes). */
void ota_set_utc_offset(int minutes);
/** Local minutes since midnight, or -1 if the clock isn't set. */
int ota_local_minute(void);

/** Ask for a manifest check; with `install`, install a newer version right away. */
void ota_check(bool install);
/** A newer, verified version is waiting to install ("" = none). */
const char *ota_available(void);
ota_state_t ota_state(void);
int ota_progress(void);  // percent while downloading
/** Manifest URL (NVS override, else Kconfig). */
void ota_manifest_url(char *out, int len);
void ota_set_manifest_url(const char *url);  // NULL/"" = back to the default
void ota_print_status(void);
