#include "storage.h"

#include <string.h>

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sdkconfig.h"
#if CONFIG_NVS_ENCRYPTION
#include "esp_efuse.h"
#include "esp_efuse_chip.h"
#endif

static const char *TAG = "storage";

#if CONFIG_NVS_ENCRYPTION && !CONFIG_NVS_SEC_KEY_PROTECT_USING_HMAC
#error "Open Lounge Phone encrypts NVS with the HMAC scheme (no flash encryption needed)"
#endif
#if CONFIG_NVS_ENCRYPTION && CONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID < 0
#error "set CONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID (sdkconfig.release uses KEY5)"
#endif

bool storage_encrypted(void) {
#if CONFIG_NVS_ENCRYPTION
  return true;
#else
  return false;
#endif
}

static esp_err_t open_nvs(void) {
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_LOGW(TAG, "NVS unreadable (%s): erasing it", esp_err_to_name(err));
    nvs_flash_erase();
    err = nvs_flash_init();
  }
  return err;
}

esp_err_t storage_init(void) {
#if CONFIG_NVS_ENCRYPTION
  esp_efuse_block_t blk = (esp_efuse_block_t)(EFUSE_BLK_KEY0 + CONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID);
  bool had_key = esp_efuse_get_key_purpose(blk) == ESP_EFUSE_KEY_PURPOSE_HMAC_UP;
  if (!had_key) {
    // One-time and irreversible: a random 256-bit key is written into this eFuse block with
    // the purpose HMAC_UP and read-protected; software can use it through the HMAC peripheral,
    // never read it. Any NVS data written before (unencrypted) can no longer be read.
    ESP_LOGW(TAG, "FIRST ENCRYPTED BOOT: burning a new NVS HMAC key into eFuse KEY%d",
             CONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID);
  }
  esp_err_t err = open_nvs();
  ESP_LOGI(TAG, "STORAGE encrypted (NVS, HMAC key in eFuse KEY%d, %s): %s",
           CONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID, had_key ? "existing" : "new", esp_err_to_name(err));
  return err;
#else
  esp_err_t err = open_nvs();
  ESP_LOGW(TAG, "STORAGE NOT encrypted (development build): %s", esp_err_to_name(err));
  return err;
#endif
}

typedef struct {
  const char *key;
  char value[260];
  bool present;
} kept_t;

void storage_wipe(bool keep_wifi) {
  kept_t kept[] = {{"ssid"}, {"pass"}, {"server"}, {"ota_url"}};  // namespace "net"
  const int n = sizeof kept / sizeof kept[0];
  if (keep_wifi) {
    nvs_handle_t h;
    if (nvs_open("net", NVS_READONLY, &h) == ESP_OK) {
      for (int i = 0; i < n; i++) {
        size_t len = sizeof kept[i].value;
        kept[i].present = nvs_get_str(h, kept[i].key, kept[i].value, &len) == ESP_OK;
      }
      nvs_close(h);
    }
  }
  nvs_flash_deinit();
  esp_err_t err = nvs_flash_erase();  // every sector of the partition, physically
  ESP_LOGW(TAG, "WIPE: NVS partition erased (%s)%s", esp_err_to_name(err),
           keep_wifi ? "; putting Wi-Fi and the server back" : "");
  open_nvs();
  if (keep_wifi) {
    nvs_handle_t h;
    if (nvs_open("net", NVS_READWRITE, &h) == ESP_OK) {
      for (int i = 0; i < n; i++)
        if (kept[i].present) nvs_set_str(h, kept[i].key, kept[i].value);
      nvs_commit(h);
      nvs_close(h);
    }
  }
  memset(kept, 0, sizeof kept);  // the Wi-Fi password doesn't linger in RAM
}
