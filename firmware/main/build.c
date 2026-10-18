#include "build.h"

#include <string.h>

#include "build_core.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "nvs.h"

static const char *TAG = "build";
static bool s_official;
static char s_hex[2 * BUILD_SHA_LEN + 1];

/** The record for a slot, if there is one. */
static bool read_record(const esp_partition_t *part, uint8_t out[BUILD_SHA_LEN]) {
  char key[16];
  if (!part || !build_slot_key(part->label, key, sizeof key)) return false;
  nvs_handle_t h;
  if (nvs_open(BUILD_NVS_NS, NVS_READONLY, &h) != ESP_OK) return false;
  size_t len = BUILD_SHA_LEN;
  bool ok = nvs_get_blob(h, key, out, &len) == ESP_OK && len == BUILD_SHA_LEN;
  nvs_close(h);
  return ok;
}

void build_init(void) {
  const esp_app_desc_t *d = esp_app_get_description();
  build_hex(d->app_elf_sha256, s_hex);
  uint8_t rec[BUILD_SHA_LEN];
  const esp_partition_t *running = esp_ota_get_running_partition();
  s_official = build_official(d->app_elf_sha256, read_record(running, rec) ? rec : NULL);
  ESP_LOGI(TAG, "BUILD %s %s sha256=%.16s... official=%s (slot %s)", d->project_name, d->version,
           s_hex, s_official ? "yes" : "no", running ? running->label : "?");
}

bool build_is_official(void) { return s_official; }

const char *build_sha_hex(void) { return s_hex; }

void build_add_to_hello(cJSON *hello) {
  const esp_app_desc_t *d = esp_app_get_description();
  cJSON *b = cJSON_AddObjectToObject(hello, "build");
  cJSON_AddStringToObject(b, "sha256", s_hex);
  cJSON_AddStringToObject(b, "project", d->project_name[0] ? d->project_name : "unknown");
  cJSON_AddStringToObject(b, "version", d->version[0] ? d->version : "unknown");
  cJSON_AddBoolToObject(b, "official", s_official);
}

void build_record_installed(const esp_partition_t *part) {
  esp_app_desc_t d;
  char key[16];
  if (!part || esp_ota_get_partition_description(part, &d) != ESP_OK ||
      !build_slot_key(part->label, key, sizeof key)) {
    ESP_LOGW(TAG, "BUILD could not record the installed image");
    return;
  }
  nvs_handle_t h;
  if (nvs_open(BUILD_NVS_NS, NVS_READWRITE, &h) != ESP_OK) return;
  esp_err_t e = nvs_set_blob(h, key, d.app_elf_sha256, BUILD_SHA_LEN);
  if (e == ESP_OK) e = nvs_commit(h);
  nvs_close(h);
  char hex[2 * BUILD_SHA_LEN + 1];
  build_hex(d.app_elf_sha256, hex);
  ESP_LOGI(TAG, "BUILD recorded %s for %s: %.16s... (%s)", d.version, part->label, hex,
           esp_err_to_name(e));
}
