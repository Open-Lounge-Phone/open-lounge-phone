// The firmware's own build for `hello.build` (build_core.h): the running image's hash, project
// and version, and whether this phone installed it itself through its signed update path.
#pragma once
#include <stdbool.h>
#include "cJSON.h"
#include "esp_partition.h"

/** Reads the running image's hash and its slot's record (once, at boot, after NVS is open). */
void build_init(void);
/** Whether the running image is the one the phone's update path installed and verified. */
bool build_is_official(void);
/** The running image's SHA-256 (ESP-IDF's app ELF hash) as hex. */
const char *build_sha_hex(void);
/** Adds `build` {sha256, project, version, official} to a hello. */
void build_add_to_hello(cJSON *hello);
/** ota.c, after it verified and selected an update: records that image's hash for its slot. */
void build_record_installed(const esp_partition_t *part);
