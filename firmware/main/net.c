// Wi-Fi station (credentials from NVS, else Kconfig) and the WebSocket to the server
// (esp_websocket_client + TLS with the ESP-IDF certificate bundle).
// TODO: SoftAP provisioning ("OpenLoungePhone-XXXX" + a setup page), see docs/device-lifecycle.md.
#include "net.h"

#include <stdlib.h>
#include <string.h>

#include "app.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_websocket_client.h"
#include "esp_wifi.h"
#include "nvs.h"
#include "sdkconfig.h"

static const char *TAG = "net";
#define NS "net"  // kept across a wipe
#define MAX_MSG 16384

static esp_websocket_client_handle_t s_ws;
static volatile bool s_wifi_up;
static char s_ssid[33];
static esp_netif_t *s_netif;
static char *s_rx;  // reassembly buffer for one message
static size_t s_rx_len;

static void nvs_str(const char *key, char *out, size_t len, const char *fallback) {
  nvs_handle_t h;
  size_t l = len;
  if (nvs_open(NS, NVS_READONLY, &h) == ESP_OK) {
    esp_err_t err = nvs_get_str(h, key, out, &l);
    nvs_close(h);
    if (err == ESP_OK) return;
  }
  strncpy(out, fallback, len - 1);
  out[len - 1] = '\0';
}

static void nvs_put(const char *key, const char *value) {
  nvs_handle_t h;
  if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
  nvs_set_str(h, key, value);
  nvs_commit(h);
  nvs_close(h);
}

void net_server_url(char *out, size_t len) { nvs_str("server", out, len, CONFIG_OLP_SERVER_URL); }
void net_set_server(const char *url) { nvs_put("server", url); }
bool net_wifi_up(void) { return s_wifi_up; }

void net_wifi_info(char *ssid, size_t ssid_len, int *rssi, char *ip, size_t ip_len) {
  strncpy(ssid, s_ssid, ssid_len - 1);
  ssid[ssid_len - 1] = '\0';
  *rssi = 0;
  ip[0] = '\0';
  if (!s_wifi_up) return;
  wifi_ap_record_t ap;
  if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) *rssi = ap.rssi;
  esp_netif_ip_info_t info;
  if (esp_netif_get_ip_info(s_netif, &info) == ESP_OK) snprintf(ip, ip_len, IPSTR, IP2STR(&info.ip));
}

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  static int retries;
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
    if (s_ssid[0]) esp_wifi_connect();
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    if (s_wifi_up) app_post(EV_WIFI_DOWN, 0, NULL);
    s_wifi_up = false;
    // Back off a little (up to ~10 s) and try again, forever.
    int delay = retries < 10 ? 500 * (retries + 1) : 10000;
    retries++;
    ESP_LOGW(TAG, "wifi disconnected; retry in %d ms", delay);
    vTaskDelay(pdMS_TO_TICKS(delay));
    if (s_ssid[0]) esp_wifi_connect();
  } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    ip_event_got_ip_t *e = data;
    retries = 0;
    s_wifi_up = true;
    ESP_LOGI(TAG, "WIFI connected ip=" IPSTR, IP2STR(&e->ip_info.ip));
    app_post(EV_WIFI_UP, 0, NULL);
  }
}

static void apply_wifi(void) {
  char pass[65];
  nvs_str("ssid", s_ssid, sizeof s_ssid, CONFIG_OLP_WIFI_SSID);
  nvs_str("pass", pass, sizeof pass, CONFIG_OLP_WIFI_PASSWORD);
  wifi_config_t cfg = {0};
  strncpy((char *)cfg.sta.ssid, s_ssid, sizeof cfg.sta.ssid);
  strncpy((char *)cfg.sta.password, pass, sizeof cfg.sta.password);
  cfg.sta.threshold.authmode = pass[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &cfg));
  ESP_LOGI(TAG, "wifi: %s", s_ssid[0] ? s_ssid : "(not set: use `wifi <ssid> <pass>`)");
}

void net_start(void) {
  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  s_netif = esp_netif_create_default_wifi_sta();
  wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&init));
  ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL));
  ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL));
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  apply_wifi();
  ESP_ERROR_CHECK(esp_wifi_start());
}

void net_set_wifi(const char *ssid, const char *pass) {
  nvs_put("ssid", ssid);
  nvs_put("pass", pass ? pass : "");
  esp_wifi_disconnect();
  apply_wifi();
  esp_wifi_connect();
}

static void ws_event(void *arg, esp_event_base_t base, int32_t id, void *event_data) {
  esp_websocket_event_data_t *d = event_data;
  switch (id) {
    case WEBSOCKET_EVENT_CONNECTED:
      app_post(EV_WS_OPEN, 0, NULL);
      break;
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED:
      app_post(EV_WS_CLOSED, 0, NULL);
      break;
    case WEBSOCKET_EVENT_DATA:
      if (d->op_code == 0x8 && d->data_len >= 2) {  // close frame: status code first
        int code = ((uint8_t)d->data_ptr[0] << 8) | (uint8_t)d->data_ptr[1];
        ESP_LOGW(TAG, "WS close %d %.*s", code, d->data_len - 2, d->data_ptr + 2);
        app_post(EV_WS_CLOSED, code, NULL);
        break;
      }
      if (d->op_code != 0x1 && d->op_code != 0x0) break;  // text (and its continuation)
      if (d->payload_len > MAX_MSG) break;
      if (d->payload_offset == 0) {
        free(s_rx);
        s_rx = malloc(d->payload_len + 1);
        s_rx_len = 0;
      }
      if (!s_rx) break;
      memcpy(s_rx + d->payload_offset, d->data_ptr, d->data_len);
      s_rx_len = d->payload_offset + d->data_len;
      if (s_rx_len >= (size_t)d->payload_len) {
        s_rx[s_rx_len] = '\0';
        app_post(EV_WS_MSG, 0, s_rx);  // the app frees it
        s_rx = NULL;
      }
      break;
    case WEBSOCKET_EVENT_ERROR:
      ESP_LOGW(TAG, "WS error");
      break;
    default:
      break;
  }
}

void net_ws_open(const char *url) {
  if (s_ws) {
    esp_websocket_client_stop(s_ws);
    esp_websocket_client_destroy(s_ws);
    s_ws = NULL;
  }
#if CONFIG_OLP_SIM
  // Wokwi emulates the S3's software ECC ~7x slower than silicon, so a full handshake with the
  // bundle (P-256 + P-384 chain checks, ECDHE) outlasts Cloudflare's handshake timeout. The sim
  // build trusts the servers' current intermediate (Google Trust Services WE1, until 2029-02)
  // directly, which skips the P-384 check. Hardware builds always use the certificate bundle.
  extern const char sim_ca_start[] asm("_binary_sim_ca_we1_pem_start");
#endif
  esp_websocket_client_config_t cfg = {
      .uri = url,
#if CONFIG_OLP_SIM
      .cert_pem = sim_ca_start,
#else
      .crt_bundle_attach = esp_crt_bundle_attach,
#endif
      .buffer_size = 4096,
      .task_stack = 8192,
      .reconnect_timeout_ms = 2000,
      .network_timeout_ms = 15000,
      .ping_interval_sec = 30,
  };
  s_ws = esp_websocket_client_init(&cfg);
  esp_websocket_register_events(s_ws, WEBSOCKET_EVENT_ANY, ws_event, NULL);
  ESP_LOGI(TAG, "WS connecting %s", url);
  esp_websocket_client_start(s_ws);
}

void net_ws_close(void) {
  if (s_ws) esp_websocket_client_close(s_ws, pdMS_TO_TICKS(2000));
}

bool net_ws_send(const char *text) {
  if (!s_ws || !esp_websocket_client_is_connected(s_ws)) return false;
  return esp_websocket_client_send_text(s_ws, text, strlen(text), pdMS_TO_TICKS(5000)) >= 0;
}
