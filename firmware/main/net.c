// Wi-Fi station (credentials from NVS, else Kconfig) and the WebSocket to the server
// (esp_websocket_client + TLS with the ESP-IDF certificate bundle). The setup network (SoftAP
// provisioning) is prov.c; it saves credentials here.
#include "net.h"

#include <stdlib.h>
#include <string.h>

#include "app.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_netif.h"
#include "esp_websocket_client.h"
#include "esp_wifi.h"
#if CONFIG_OLP_QEMU
#include "esp_eth.h"
#endif
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
#if !CONFIG_OLP_QEMU
  wifi_ap_record_t ap;
  if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) *rssi = ap.rssi;
#endif
  esp_netif_ip_info_t info;
  if (esp_netif_get_ip_info(s_netif, &info) == ESP_OK) snprintf(ip, ip_len, IPSTR, IP2STR(&info.ip));
}

static esp_timer_handle_t s_retry;
static volatile bool s_slow_retry;  // the setup network is up: retry rarely (scans disturb it)

bool net_has_wifi(void) {
  char ssid[33];
  nvs_str("ssid", ssid, sizeof ssid, CONFIG_OLP_WIFI_SSID);
  return ssid[0] != '\0';
}

void net_slow_retry(bool slow) { s_slow_retry = slow; }

static void retry_now(void *arg) {
  if (s_ssid[0]) esp_wifi_connect();
}

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  static int retries;
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
    if (s_ssid[0]) esp_wifi_connect();
    else app_post(EV_WIFI_DOWN, 0, NULL);  // nothing to join: the setup network decides
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    s_wifi_up = false;
    app_post(EV_WIFI_DOWN, 0, NULL);
    // Back off a little (up to ~10 s; a minute while the setup network is up: a station
    // scanning for a missing network hops channels and drops the setup network's clients).
    int delay = s_slow_retry ? 60000 : retries < 10 ? 500 * (retries + 1) : 10000;
    retries++;
    ESP_LOGW(TAG, "wifi disconnected; retry in %d ms", delay);
    esp_timer_stop(s_retry);
    esp_timer_start_once(s_retry, (uint64_t)delay * 1000);
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
  // Fixed-size fields, not necessarily NUL-terminated (a 32-byte SSID fills it).
  memcpy(cfg.sta.ssid, s_ssid, strnlen(s_ssid, sizeof cfg.sta.ssid));
  memcpy(cfg.sta.password, pass, strnlen(pass, sizeof cfg.sta.password));
  cfg.sta.threshold.authmode = pass[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &cfg));
  ESP_LOGI(TAG, "wifi: %s", s_ssid[0] ? s_ssid : "(not set: use `wifi <ssid> <pass>`)");
}

#if CONFIG_OLP_QEMU
// QEMU has no Wi-Fi: its OpenCores Ethernet (user-mode NAT) stands in for it. Everything above
// the link (DHCP, DNS, TLS, UDP for WebRTC) is the same as on the board.
static void eth_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  if (base == IP_EVENT && id == IP_EVENT_ETH_GOT_IP) {
    ip_event_got_ip_t *e = data;
    s_wifi_up = true;
    ESP_LOGI(TAG, "WIFI connected ip=" IPSTR " (QEMU Ethernet)", IP2STR(&e->ip_info.ip));
    app_post(EV_WIFI_UP, 0, NULL);
  } else if (base == ETH_EVENT && id == ETHERNET_EVENT_DISCONNECTED) {
    if (s_wifi_up) app_post(EV_WIFI_DOWN, 0, NULL);
    s_wifi_up = false;
  }
}

static void start_qemu_ethernet(void) {
  esp_netif_config_t ncfg = ESP_NETIF_DEFAULT_ETH();
  s_netif = esp_netif_new(&ncfg);
  eth_mac_config_t mac_cfg = ETH_MAC_DEFAULT_CONFIG();
  eth_phy_config_t phy_cfg = ETH_PHY_DEFAULT_CONFIG();
  phy_cfg.autonego_timeout_ms = 100;
  esp_eth_mac_t *mac = esp_eth_mac_new_openeth(&mac_cfg);
  esp_eth_phy_t *phy = esp_eth_phy_new_dp83848(&phy_cfg);
  esp_eth_config_t cfg = ETH_DEFAULT_CONFIG(mac, phy);
  esp_eth_handle_t eth = NULL;
  ESP_ERROR_CHECK(esp_eth_driver_install(&cfg, &eth));
  ESP_ERROR_CHECK(esp_netif_attach(s_netif, esp_eth_new_netif_glue(eth)));
  ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_ETH_GOT_IP, eth_event, NULL));
  ESP_ERROR_CHECK(esp_event_handler_register(ETH_EVENT, ESP_EVENT_ANY_ID, eth_event, NULL));
  char saved[33];
  nvs_str("ssid", saved, sizeof saved, CONFIG_OLP_WIFI_SSID);
  ESP_LOGI(TAG, "saved Wi-Fi: %s (QEMU uses its Ethernet)", saved[0] ? saved : "(none)");
  snprintf(s_ssid, sizeof s_ssid, "qemu-ethernet");
  ESP_ERROR_CHECK(esp_eth_start(eth));
}
#endif

void net_start(void) {
#if CONFIG_OLP_QEMU
  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  start_qemu_ethernet();
  return;
#endif
  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  s_netif = esp_netif_create_default_wifi_sta();
  wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&init));
  ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL));
  ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL));
  const esp_timer_create_args_t t = {.callback = retry_now, .name = "wifi_retry"};
  ESP_ERROR_CHECK(esp_timer_create(&t, &s_retry));
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  apply_wifi();
  ESP_ERROR_CHECK(esp_wifi_start());
}

void net_save_wifi(const char *ssid, const char *pass) {
  nvs_put("ssid", ssid);
  nvs_put("pass", pass ? pass : "");
}

void net_set_wifi(const char *ssid, const char *pass) {
  nvs_put("ssid", ssid);
  nvs_put("pass", pass ? pass : "");
#if CONFIG_OLP_QEMU
  return;  // no Wi-Fi driver in QEMU: saved only
#endif
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
#if CONFIG_OLP_SIM && !CONFIG_OLP_QEMU
  // Wokwi emulates the S3's software ECC ~7x slower than silicon, so a full handshake with the
  // bundle (P-256 + P-384 chain checks, ECDHE) outlasts Cloudflare's handshake timeout. The sim
  // build trusts the servers' current intermediate (Google Trust Services WE1, until 2029-02;
  // l1 and the hub use it: check with `openssl s_client -showcerts`)
  // directly, which skips the P-384 check. Hardware builds always use the certificate bundle.
  extern const char sim_ca_start[] asm("_binary_sim_ca_we1_pem_start");
#endif
  esp_websocket_client_config_t cfg = {
      .uri = url,
#if CONFIG_OLP_SIM && !CONFIG_OLP_QEMU
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
