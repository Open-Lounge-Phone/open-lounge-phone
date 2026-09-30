// The phone's storage: NVS, encrypted at rest in release builds (CONFIG_OLP_STORAGE_ENCRYPTED:
// ESP-IDF's HMAC-based NVS encryption; the HMAC key lives in an eFuse block, burned on the first
// boot, and never leaves the chip), plus the wipes that erase it properly.
#pragma once
#include <stdbool.h>
#include "esp_err.h"

/** Opens NVS (burning the eFuse HMAC key on the very first encrypted boot). */
esp_err_t storage_init(void);
bool storage_encrypted(void);
/**
 * Erases the whole NVS partition (a physical flash erase, not "mark deleted": nothing old stays
 * on the chip, encrypted or not) and opens it again. With `keep_wifi`, the Wi-Fi credentials, the
 * server URL and the update URL are put back (remote removal); without, it's a factory reset.
 */
void storage_wipe(bool keep_wifi);
