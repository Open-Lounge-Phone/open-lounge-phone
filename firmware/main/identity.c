#include "identity.h"

#include <string.h>

#include "esp_log.h"
#include "esp_random.h"
#include "mbedtls/base64.h"
#include "mbedtls/ecdsa.h"
#include "mbedtls/sha256.h"
#include "nvs.h"

static const char *TAG = "identity";
#define NS "olp"  // identity + settings; erased by a wipe (Wi-Fi lives in "net")

static uint8_t s_priv[32];
static uint8_t s_pub[65];
static char s_pub_b64[96];
static char s_device_id[65];
static const char *s_words[4];

static int rng(void *ctx, unsigned char *buf, size_t len) {
  (void)ctx;
  esp_fill_random(buf, len);  // true random once the radio is on (identity_init runs after Wi-Fi starts)
  return 0;
}

int b64url_encode(const uint8_t *in, size_t len, char *out, size_t out_len) {
  size_t olen = 0;
  if (mbedtls_base64_encode((unsigned char *)out, out_len, &olen, in, len) != 0) return -1;
  while (olen > 0 && out[olen - 1] == '=') olen--;
  out[olen] = '\0';
  for (size_t i = 0; i < olen; i++) {
    if (out[i] == '+') out[i] = '-';
    else if (out[i] == '/') out[i] = '_';
  }
  return (int)olen;
}

int b64url_decode(const char *in, uint8_t *out, size_t out_len) {
  size_t n = strlen(in);
  char buf[256];
  if (n + 4 >= sizeof buf) return -1;
  for (size_t i = 0; i < n; i++) buf[i] = in[i] == '-' ? '+' : in[i] == '_' ? '/' : in[i];
  while (n % 4) buf[n++] = '=';
  buf[n] = '\0';
  size_t olen = 0;
  if (mbedtls_base64_decode(out, out_len, &olen, (const unsigned char *)buf, n) != 0) return -1;
  return (int)olen;
}

static bool generate(void) {
  mbedtls_ecp_group grp;
  mbedtls_mpi d;
  mbedtls_ecp_point q;
  mbedtls_ecp_group_init(&grp);
  mbedtls_mpi_init(&d);
  mbedtls_ecp_point_init(&q);
  size_t olen = 0;
  bool ok = mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_SECP256R1) == 0 &&
            mbedtls_ecp_gen_keypair(&grp, &d, &q, rng, NULL) == 0 &&
            mbedtls_mpi_write_binary(&d, s_priv, sizeof s_priv) == 0 &&
            mbedtls_ecp_point_write_binary(&grp, &q, MBEDTLS_ECP_PF_UNCOMPRESSED, &olen, s_pub,
                                           sizeof s_pub) == 0 &&
            olen == 65;
  mbedtls_ecp_point_free(&q);
  mbedtls_mpi_free(&d);
  mbedtls_ecp_group_free(&grp);
  return ok;
}

void identity_init(void) {
  nvs_handle_t h;
  ESP_ERROR_CHECK(nvs_open(NS, NVS_READWRITE, &h));
  size_t lp = sizeof s_priv, lq = sizeof s_pub;
  if (nvs_get_blob(h, "priv", s_priv, &lp) != ESP_OK || nvs_get_blob(h, "pub", s_pub, &lq) != ESP_OK ||
      lp != 32 || lq != 65) {
    ESP_LOGI(TAG, "no device key: generating a P-256 key");
    if (!generate()) {
      ESP_LOGE(TAG, "key generation failed");
      abort();
    }
    ESP_ERROR_CHECK(nvs_set_blob(h, "priv", s_priv, sizeof s_priv));
    ESP_ERROR_CHECK(nvs_set_blob(h, "pub", s_pub, sizeof s_pub));
    ESP_ERROR_CHECK(nvs_commit(h));
  }
  size_t ld = sizeof s_device_id;
  if (nvs_get_str(h, "device_id", s_device_id, &ld) != ESP_OK) s_device_id[0] = '\0';
  nvs_close(h);

  b64url_encode(s_pub, sizeof s_pub, s_pub_b64, sizeof s_pub_b64);
  uint8_t digest[32];
  mbedtls_sha256(s_pub, sizeof s_pub, digest, 0);
  for (int i = 0; i < 4; i++) s_words[i] = FINGERPRINT_WORDS[digest[i]];
  ESP_LOGI(TAG, "fingerprint: %s %s %s %s", s_words[0], s_words[1], s_words[2], s_words[3]);
  ESP_LOGI(TAG, "device id: %s", s_device_id[0] ? s_device_id : "(unpaired)");
}

const char *identity_public_key_b64(void) { return s_pub_b64; }
const char *const *identity_fingerprint(void) { return s_words; }
const char *identity_device_id(void) { return s_device_id; }

void identity_set_device_id(const char *id) {
  strncpy(s_device_id, id ? id : "", sizeof s_device_id - 1);
  s_device_id[sizeof s_device_id - 1] = '\0';
  nvs_handle_t h;
  if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
  if (s_device_id[0]) nvs_set_str(h, "device_id", s_device_id);
  else nvs_erase_key(h, "device_id");
  nvs_commit(h);
  nvs_close(h);
}

bool identity_sign_b64(const uint8_t *msg, size_t len, char *out, size_t out_len) {
  uint8_t hash[32], sig[64];
  mbedtls_sha256(msg, len, hash, 0);
  mbedtls_ecp_group grp;
  mbedtls_mpi d, r, s;
  mbedtls_ecp_group_init(&grp);
  mbedtls_mpi_init(&d);
  mbedtls_mpi_init(&r);
  mbedtls_mpi_init(&s);
  bool ok = mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_SECP256R1) == 0 &&
            mbedtls_mpi_read_binary(&d, s_priv, sizeof s_priv) == 0 &&
            mbedtls_ecdsa_sign(&grp, &r, &s, &d, hash, sizeof hash, rng, NULL) == 0 &&
            mbedtls_mpi_write_binary(&r, sig, 32) == 0 &&
            mbedtls_mpi_write_binary(&s, sig + 32, 32) == 0;  // r‖s (IEEE P1363)
  mbedtls_mpi_free(&s);
  mbedtls_mpi_free(&r);
  mbedtls_mpi_free(&d);
  mbedtls_ecp_group_free(&grp);
  return ok && b64url_encode(sig, sizeof sig, out, out_len) == 86;
}

void identity_wipe(void) {
  nvs_handle_t h;
  if (nvs_open(NS, NVS_READWRITE, &h) == ESP_OK) {
    nvs_erase_all(h);
    nvs_commit(h);
    nvs_close(h);
  }
  memset(s_priv, 0, sizeof s_priv);
  s_device_id[0] = '\0';
  ESP_LOGW(TAG, "wiped the device key, id and settings (Wi-Fi kept)");
}
