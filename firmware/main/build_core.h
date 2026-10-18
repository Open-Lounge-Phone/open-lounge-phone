// The firmware's own build, the pure parts (docs/security-model.md "Firmware changes"): the
// running image's SHA-256 as hex, and whether it is the image this phone installed itself
// through its signed update path. ota.c records each verified image's hash in NVS (per update
// slot) when it installs it; build.c compares the running image with that record at boot. A
// build from source or a USB flash has no matching record, so it reports official: false.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define BUILD_SHA_LEN 32
/** NVS namespace for the records ("v_<slot label>" = the verified image's 32-byte hash). */
#define BUILD_NVS_NS "build"

/** Lowercase hex of a 32-byte hash into `out` (65 bytes with the NUL). */
void build_hex(const uint8_t sha[BUILD_SHA_LEN], char out[2 * BUILD_SHA_LEN + 1]);

/**
 * The image running is the one the phone installed and verified itself: there is a record for
 * its slot (`recorded`, NULL = none) and it is the same hash. An all-zero hash never counts.
 */
bool build_official(const uint8_t running[BUILD_SHA_LEN], const uint8_t *recorded);

/** The NVS key for an update slot's record ("ota_0" -> "v_ota_0"). False if it doesn't fit. */
bool build_slot_key(const char *slot_label, char *out, size_t n);
