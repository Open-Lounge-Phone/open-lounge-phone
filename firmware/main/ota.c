#include "ota.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "app.h"
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "esp_ota_ops.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "mbedtls/base64.h"
#include "mbedtls/pk.h"
#include "mbedtls/sha256.h"
#include "nvs.h"
#include "ota_core.h"
#include "sdkconfig.h"

static const char *TAG = "ota";
#define NS "net"                    // kept across a wipe, like the server URL
#define TRIAL_MS (5 * 60 * 1000)    // a trial firmware that can't reach the server goes back
#define MANIFEST_MAX 2048
#define CHUNK 4096

#if CONFIG_OLP_OTA
extern const char pubkey_start[] asm("_binary_ota_pubkey_pem_start");
#define DEFAULT_URL CONFIG_OLP_OTA_MANIFEST_URL
#else
#define DEFAULT_URL ""  // no update key in this build: updates are off
#endif

static QueueHandle_t s_cmds;
static volatile ota_state_t s_state = OTA_IDLE;
static volatile int s_progress;
static char s_available[32];
static bool s_trial;
static esp_timer_handle_t s_trial_timer;
static volatile int s_utc_offset_min;
static volatile bool s_offset_known;

ota_state_t ota_state(void) { return s_state; }
int ota_progress(void) { return s_progress; }
const char *ota_available(void) { return s_available; }

void ota_manifest_url(char *out, int len) {
  out[0] = '\0';
#if !CONFIG_OLP_OTA
  return;  // nothing could verify an update: no URL either
#endif
  nvs_handle_t h;
  size_t l = (size_t)len;
  if (nvs_open(NS, NVS_READONLY, &h) == ESP_OK) {
    esp_err_t err = nvs_get_str(h, "ota_url", out, &l);
    nvs_close(h);
    if (err == ESP_OK && out[0]) return;
  }
  snprintf(out, len, "%s", DEFAULT_URL);
}

bool ota_built_in(void) {
#if CONFIG_OLP_OTA
  return true;
#else
  return false;
#endif
}

bool ota_enabled(void) {
  char url[OTA_URL_LEN];
  ota_manifest_url(url, sizeof url);
  return url[0] != '\0';
}

void ota_set_manifest_url(const char *url) {
  nvs_handle_t h;
  if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
  if (url && url[0]) nvs_set_str(h, "ota_url", url);
  else nvs_erase_key(h, "ota_url");
  nvs_commit(h);
  nvs_close(h);
}

// --- trial boot and rollback ----------------------------------------------------------------

static void trial_expired(void *arg) {
  ESP_LOGE(TAG, "OTA TRIAL FAILED: no server within %d min: rolling back", TRIAL_MS / 60000);
  esp_ota_mark_app_invalid_rollback_and_reboot();
}

void ota_boot(void) {
  const esp_app_desc_t *me = esp_app_get_description();
  const esp_partition_t *run = esp_ota_get_running_partition();
  esp_ota_img_states_t st;
  ESP_LOGI(TAG, "running %s from %s", me->version, run ? run->label : "?");
  const esp_partition_t *bad = esp_ota_get_last_invalid_partition();
  esp_app_desc_t d;
  if (bad && esp_ota_get_partition_description(bad, &d) == ESP_OK)
    ESP_LOGW(TAG, "OTA ROLLED BACK: %s (in %s) didn't start properly; running %s", d.version,
             bad->label, me->version);
  if (run && esp_ota_get_state_partition(run, &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY) {
    s_trial = true;
    ESP_LOGW(TAG, "OTA TRIAL %s: kept once the server answers, rolled back otherwise", me->version);
    const esp_timer_create_args_t t = {.callback = trial_expired, .name = "ota_trial"};
    if (esp_timer_create(&t, &s_trial_timer) == ESP_OK) esp_timer_start_once(s_trial_timer, TRIAL_MS * 1000ULL);
  }
}

void ota_server_ok(void) {
  if (!s_trial) return;
  s_trial = false;
  if (s_trial_timer) esp_timer_stop(s_trial_timer);
  esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
  ESP_LOGI(TAG, "OTA VALID %s (%s)", esp_app_get_description()->version, esp_err_to_name(err));
}

// --- clock (the overnight window) -------------------------------------------------------------

void ota_time_start(void) {
  static bool started;
  if (started) return;
  started = true;
  esp_sntp_config_t cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
  cfg.wait_for_sync = false;
  esp_netif_sntp_init(&cfg);
}

void ota_set_utc_offset(int minutes) {
  s_utc_offset_min = minutes;
  s_offset_known = true;
}

int ota_local_minute(void) {
  time_t now = time(NULL);
  if (now < 1700000000 || !s_offset_known) return -1;  // no SNTP yet, or no offset from the server
  long m = (long)(now / 60) + s_utc_offset_min;
  return (int)(((m % 1440) + 1440) % 1440);
}

// --- HTTPS ------------------------------------------------------------------------------------

static esp_http_client_handle_t open_url(const char *url, int *status, int64_t *length) {
  esp_http_client_config_t cfg = {
      .url = url,
      .crt_bundle_attach = esp_crt_bundle_attach,
      .timeout_ms = 20000,
      .buffer_size = 4096,     // GitHub's redirect Location is a long signed URL
      .buffer_size_tx = 4096,  // …and it goes into the next request line
      .disable_auto_redirect = true,
      .keep_alive_enable = true,
  };
  esp_http_client_handle_t c = esp_http_client_init(&cfg);
  if (!c) return NULL;
  for (int hop = 0; hop < 5; hop++) {
    if (esp_http_client_open(c, 0) != ESP_OK) break;
    int64_t len = esp_http_client_fetch_headers(c);
    int st = esp_http_client_get_status_code(c);
    if (st == 301 || st == 302 || st == 303 || st == 307 || st == 308) {
      char buf[256];
      while (esp_http_client_read(c, buf, sizeof buf) > 0) {}  // drain the body
      if (esp_http_client_set_redirection(c) != ESP_OK) break;
      esp_http_client_close(c);
      continue;
    }
    *status = st;
    *length = len;
    return c;
  }
  esp_http_client_cleanup(c);
  return NULL;
}

static const char *fetch_manifest(const char *url, ota_manifest_t *m) {
  int status = 0;
  int64_t len = 0;
  esp_http_client_handle_t c = open_url(url, &status, &len);
  if (!c) return "manifest download failed";
  const char *err = NULL;
  char *buf = calloc(1, MANIFEST_MAX + 1);
  int got = 0, r;
  if (!buf) err = "no memory";
  else if (status != 200) err = status == 404 ? "no manifest (404)" : "manifest HTTP error";
  while (!err && got < MANIFEST_MAX && (r = esp_http_client_read(c, buf + got, MANIFEST_MAX - got)) > 0)
    got += r;
  esp_http_client_cleanup(c);
  if (!err) err = ota_manifest_parse(buf, m);
  free(buf);
  return err;
}

static bool signature_ok(const ota_manifest_t *m) {
#if !CONFIG_OLP_OTA
  return false;
#else
  char text[512];
  int n = ota_manifest_signed_text(m, text, sizeof text);
  uint8_t hash[32], sig[512];
  size_t siglen = 0;
  if (n < 0 || mbedtls_sha256((const uint8_t *)text, (size_t)n, hash, 0) != 0) return false;
  if (mbedtls_base64_decode(sig, sizeof sig, &siglen, (const uint8_t *)m->signature,
                            strlen(m->signature)) != 0)
    return false;
  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  bool ok = false;
  if (mbedtls_pk_parse_public_key(&pk, (const uint8_t *)pubkey_start, strlen(pubkey_start) + 1) == 0) {
    mbedtls_pk_rsassa_pss_options opts = {.mgf1_hash_id = MBEDTLS_MD_SHA256,
                                          .expected_salt_len = MBEDTLS_RSA_SALT_LEN_ANY};
    ok = mbedtls_pk_verify_ext(MBEDTLS_PK_RSASSA_PSS, &opts, &pk, MBEDTLS_MD_SHA256, hash,
                               sizeof hash, sig, siglen) == 0;
  }
  mbedtls_pk_free(&pk);
  return ok;
#endif
}

/** Download, hash and flash. NULL on success (the new slot boots next), else why not. */
static const char *install(const ota_manifest_t *m) {
  const esp_partition_t *part = esp_ota_get_next_update_partition(NULL);
  if (!part) return "no update slot";
  if (m->size > part->size) return "image too big for the slot";
  int status = 0;
  int64_t len = 0;
  esp_http_client_handle_t c = open_url(m->url, &status, &len);
  if (!c) return "image download failed";
  if (status != 200) {
    esp_http_client_cleanup(c);
    return "image HTTP error";
  }
  if (len > 0 && len != (int64_t)m->size) {
    esp_http_client_cleanup(c);
    return "image size differs from the manifest";
  }
  esp_ota_handle_t h = 0;
  if (esp_ota_begin(part, m->size, &h) != ESP_OK) {
    esp_http_client_cleanup(c);
    return "flash erase failed";
  }
  uint8_t *buf = malloc(CHUNK);
  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  mbedtls_sha256_starts(&sha, 0);
  const char *err = buf ? NULL : "no memory";
  uint32_t total = 0;
  int last_log = -1;
  s_state = OTA_DOWNLOADING;
  while (!err) {
    int r = esp_http_client_read(c, (char *)buf, CHUNK);
    if (r < 0) err = "download interrupted";
    if (r <= 0) break;
    if (total + (uint32_t)r > m->size) err = "image larger than the manifest says";
    else if (esp_ota_write(h, buf, (size_t)r) != ESP_OK) err = "flash write failed";
    if (err) break;
    mbedtls_sha256_update(&sha, buf, (size_t)r);
    total += (uint32_t)r;
    s_progress = (int)((uint64_t)total * 100 / m->size);
    if (s_progress / 25 != last_log) {
      last_log = s_progress / 25;
      ESP_LOGI(TAG, "OTA DOWNLOAD %s: %d%% (%lu bytes)", m->version, s_progress, (unsigned long)total);
    }
  }
  esp_http_client_cleanup(c);
  free(buf);
  uint8_t digest[32];
  mbedtls_sha256_finish(&sha, digest);
  mbedtls_sha256_free(&sha);
  if (!err && total != m->size) err = "image shorter than the manifest says";
  if (!err) {
    char hex[65];
    for (int i = 0; i < 32; i++) snprintf(hex + i * 2, 3, "%02x", digest[i]);
    if (strcmp(hex, m->sha256)) err = "sha256 mismatch";
  }
  if (err) {
    esp_ota_abort(h);
    return err;
  }
  // Checks the image format and, in release builds (CONFIG_SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT),
  // its Secure Boot V2 signature against the key that signed this firmware.
  esp_err_t e = esp_ota_end(h);
  if (e != ESP_OK) return e == ESP_ERR_OTA_VALIDATE_FAILED ? "image invalid (format or signature)" : "ota end failed";
  esp_app_desc_t d;
  if (esp_ota_get_partition_description(part, &d) != ESP_OK || strcmp(d.version, m->version))
    return "the image's version differs from the manifest";
  if (esp_ota_set_boot_partition(part) != ESP_OK) return "could not select the new slot";
  return NULL;
}

static void run(bool do_install) {
  char url[OTA_URL_LEN];
  ota_manifest_url(url, sizeof url);
  if (!url[0]) {
    // No update key in this build, or no channel set: no network calls at all.
    ESP_LOGI(TAG, "OTA OFF: updates not set up");
    app_post(EV_OTA_DONE, OTA_RESULT_OFF, NULL);
    return;
  }
  s_state = OTA_CHECKING;
  s_progress = 0;
  ESP_LOGI(TAG, "OTA CHECK %s", url);
  ota_manifest_t *m = calloc(1, sizeof *m);
  const char *err = m ? fetch_manifest(url, m) : "no memory";
  const char *me = esp_app_get_description()->version;
  int result = -1;
  if (!err && !signature_ok(m)) err = "bad manifest signature";
  if (err) {
    ESP_LOGW(TAG, "OTA REFUSED: %s", err);
  } else if ((err = ota_manifest_applies(m, CONFIG_OLP_BOARD_ID, me)) && !strcmp(err, "up to date")) {
    ESP_LOGI(TAG, "OTA UP TO DATE (running %s, latest %s)", me, m->version);
    s_available[0] = '\0';
    result = 0;
  } else if (err) {
    ESP_LOGW(TAG, "OTA REFUSED: %s (manifest for \"%s\", this is \"%s\")", err, m->board,
             CONFIG_OLP_BOARD_ID);
  } else if (!do_install) {
    ESP_LOGI(TAG, "OTA AVAILABLE %s (running %s)", m->version, me);
    snprintf(s_available, sizeof s_available, "%s", m->version);
    result = 1;
  } else if ((err = install(m))) {
    ESP_LOGW(TAG, "OTA REFUSED: %s", err);
  } else {
    ESP_LOGI(TAG, "OTA INSTALLED %s: restarting when the phone is idle", m->version);
    s_state = OTA_RESTARTING;
    result = 2;
  }
  free(m);
  if (s_state != OTA_RESTARTING) s_state = OTA_IDLE;
  app_post(EV_OTA_DONE, result, NULL);
}

static void task(void *arg) {
  for (;;) {
    bool install_now;
    if (xQueueReceive(s_cmds, &install_now, portMAX_DELAY) == pdTRUE) run(install_now);
  }
}

void ota_check(bool install_now) {
  if (!ota_enabled()) {
    ESP_LOGI(TAG, "OTA OFF: updates not set up");
    app_post(EV_OTA_DONE, OTA_RESULT_OFF, NULL);
    return;
  }
  ota_time_start();  // the overnight window's clock (only ever started with updates on)
  if (!s_cmds) {
    s_cmds = xQueueCreate(4, sizeof(bool));
    xTaskCreate(task, "ota", 10240, NULL, 4, NULL);
  }
  // Requests run one after the other; one made during a check (MENU -> 9 while the periodic
  // check runs) waits its turn instead of being dropped.
  if (xQueueSend(s_cmds, &install_now, 0) != pdTRUE) ESP_LOGW(TAG, "OTA busy: request dropped");
}

void ota_print_status(void) {
  char url[OTA_URL_LEN];
  ota_manifest_url(url, sizeof url);
  static const char *names[] = {"idle", "checking", "downloading", "restarting"};
  const esp_partition_t *run = esp_ota_get_running_partition();
  printf("OTA running=%s slot=%s updates=%s state=%s progress=%d available=%s trial=%d "
         "local_minute=%d url=%s\n",
         esp_app_get_description()->version, run ? run->label : "?",
         !ota_built_in() ? "off (no update key in this build)" : url[0] ? "on" : "off (no url)",
         names[s_state], s_progress, s_available[0] ? s_available : "-", s_trial,
         ota_local_minute(), url[0] ? url : "-");
}
