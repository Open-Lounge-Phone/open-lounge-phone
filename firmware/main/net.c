// Wi-Fi station (credentials from NVS, else Kconfig) and the WebSocket to the server
// (esp_websocket_client + TLS with the ESP-IDF certificate bundle). The setup network (SoftAP
// provisioning) is prov.c; it saves credentials here. On a board with a wired network (hw
// v0.901) it also runs the choice between the cable and Wi-Fi (netsel.c) and applies it: the
// cable's PHY (eth.c), the Wi-Fi station and radio, and the default route.
#include "net.h"

#include <stdlib.h>
#include <string.h>

#include "app.h"
#include "board.h"
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
#if BOARD_HAS_ETHERNET && !CONFIG_OLP_QEMU
#include "bootloader_random.h"
#endif
#include "eth.h"
#include "netsel.h"
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

#if BOARD_HAS_ETHERNET
static netsel_t s_sel;      // the cable or Wi-Fi (netsel.c)
static bool s_sta_wanted;   // the station joins the saved Wi-Fi (netsel's choice)
static bool s_ap_on;        // the setup network needs the radio
static bool s_radio;        // esp_wifi is started
static net_uplink_t s_last_used = NET_NONE;  // the last network that carried the phone
#endif

/** The station joins its saved network: always on rev A; netsel's choice with a cable. */
static bool sta_wanted(void) {
#if BOARD_HAS_ETHERNET
  return s_sta_wanted;
#else
  return true;
#endif
}

#if BOARD_HAS_ETHERNET
static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }
#endif

/** Wi-Fi joined (with an address) or lost: the app hears it directly (rev A) or through the
 * network choice (hw v0.901: it may be the cable that matters). */
static void post_wifi(bool up) {
#if BOARD_HAS_ETHERNET
  app_post(EV_NET, up ? NS_WIFI_IP : NS_WIFI_DOWN, NULL);
#else
  app_post(up ? EV_WIFI_UP : EV_WIFI_DOWN, 0, NULL);
#endif
}

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
  if (s_ssid[0] && sta_wanted()) esp_wifi_connect();
}

static int s_reason;       // the last disconnect reason (0 = none since the last join)
static int s_last_reason;  // the last one ever (diagnostics), kept after a join
static int s_key_fails;    // handshake failures in a row (a single one is often just timing)
static bool s_dropped;     // the last disconnect ended a working connection

/** Handshake failures in a row before the screen suggests the password. */
#define KEY_FAILS_FOR_PASSWORD 3

static bool key_failure(int reason) {
  return reason == WIFI_REASON_AUTH_FAIL || reason == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT ||
         reason == WIFI_REASON_HANDSHAKE_TIMEOUT || reason == WIFI_REASON_MIC_FAILURE;
}

static const char *problem_text(int reason) {
  if (reason && s_dropped) return "WI-FI DROPPED";  // it was connected: not a joining problem
  switch (reason) {
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_MIC_FAILURE:
      // One failed handshake is usually timing (it happens at boot); only a streak is likely
      // the password.
      return s_key_fails >= KEY_FAILS_FOR_PASSWORD ? "WRONG PASSWORD?" : "JOINING WI-FI";
    case WIFI_REASON_AUTH_EXPIRE:     // the router never finished the first handshake:
    case WIFI_REASON_ASSOC_EXPIRE:    // usually the radio (antenna, distance), not the password
    case WIFI_REASON_BEACON_TIMEOUT:
      return "WEAK WI-FI";
    case WIFI_REASON_NO_AP_FOUND:
    case WIFI_REASON_NO_AP_FOUND_IN_RSSI_THRESHOLD:
      return "NETWORK NOT SEEN";
    case WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY:
    case WIFI_REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD:
      return "SECURITY NOT OK";
    case 0:
      return NULL;
    default:
      return "CAN'T JOIN WI-FI";
  }
}

/** Why the phone couldn't join, in words for the screen (≤ 16 characters), or NULL. */
const char *net_wifi_problem(void) { return problem_text(s_reason); }

const char *net_last_wifi_problem(int *reason) {
  if (reason) *reason = s_last_reason;
  return problem_text(s_last_reason);
}

int net_wifi_channel(void) {
#if !CONFIG_OLP_QEMU
  wifi_ap_record_t ap;
  if (s_wifi_up && esp_wifi_sta_get_ap_info(&ap) == ESP_OK) return ap.primary;
#endif
  return 0;
}

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  static int retries;
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
    if (s_ssid[0] && sta_wanted()) esp_wifi_connect();
    else post_wifi(false);  // nothing to join: the setup network decides
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
#if BOARD_HAS_ETHERNET
    if (!s_sta_wanted) {  // turned off on purpose (the cable is in use): no problem, no retry
      s_wifi_up = s_dropped = false;
      s_reason = 0;
      post_wifi(false);
      return;
    }
#endif
    s_dropped = s_wifi_up;  // it had an address until now
    s_wifi_up = false;
    post_wifi(false);
    // Back off a little (up to ~10 s; a minute while the setup network is up: a station
    // scanning for a missing network hops channels and drops the setup network's clients).
    int delay = s_slow_retry ? 60000 : retries < 10 ? 500 * (retries + 1) : 10000;
    retries++;
    const wifi_event_sta_disconnected_t *d = data;
    s_reason = d ? d->reason : -1;
    s_last_reason = s_reason;
    s_key_fails = key_failure(s_reason) ? s_key_fails + 1 : 0;
    const char *why = net_wifi_problem();
    ESP_LOGW(TAG, "wifi disconnected (reason %d%s%s%s, rssi %d dBm); retry in %d ms", s_reason,
             why ? ": " : "", why ? why : "",
             s_reason == WIFI_REASON_NO_AP_FOUND        ? ", 5 GHz only? out of range?"
             : !strcmp(why ? why : "", "WEAK WI-FI") ? ", check the antenna on the U.FL"
                                                     : "",
             d ? d->rssi : 0, delay);
    esp_timer_stop(s_retry);
    esp_timer_start_once(s_retry, (uint64_t)delay * 1000);
  } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    ip_event_got_ip_t *e = data;
    retries = 0;
    s_reason = 0;
    s_key_fails = 0;
    s_dropped = false;
    s_wifi_up = true;
    ESP_LOGI(TAG, "WIFI connected ip=" IPSTR, IP2STR(&e->ip_info.ip));
    post_wifi(true);
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
  cfg.sta.threshold.authmode = pass[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;  // WPA2 or better
  cfg.sta.pmf_cfg.capable = true;               // WPA3 and WPA2/WPA3 routers need PMF
  cfg.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;      // both WPA3 key-exchange methods
  cfg.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;  // mesh systems: every access point with this name
  cfg.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;  // and join the strongest
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &cfg));
  ESP_LOGI(TAG, "wifi: %s", s_ssid[0] ? s_ssid : "(not set: use `wifi <ssid> <pass>`)");
}

#if CONFIG_OLP_QEMU && !BOARD_HAS_ETHERNET
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

#if BOARD_HAS_ETHERNET
// --- the cable or Wi-Fi (hw v0.901) ------------------------------------------------------------

/** The radio runs while the station is wanted or the setup network is open. With it off, the
 * SAR ADC keeps the random number generator truly random (TLS, keys): the radio is its other
 * entropy source, and the two can't run together. */
static void radio_apply(void) {
#if !CONFIG_OLP_QEMU
  bool want = s_sta_wanted || s_ap_on;
  if (want && !s_radio) {
    bootloader_random_disable();
    esp_err_t err = esp_wifi_start();  // STA_START joins the saved network if it's wanted
    if (err != ESP_OK) {
      ESP_LOGE(TAG, "wifi start failed: %s", esp_err_to_name(err));
      bootloader_random_enable();
      return;
    }
    s_radio = true;
    esp_err_t ps = esp_wifi_set_ps(WIFI_PS_NONE);  // as on rev A: no modem sleep
    if (ps != ESP_OK) ESP_LOGW(TAG, "wifi power save stays on: %s", esp_err_to_name(ps));
    ESP_LOGI(TAG, "NET Wi-Fi radio on");
  } else if (!want && s_radio) {
    esp_timer_stop(s_retry);
    esp_wifi_stop();
    s_radio = s_wifi_up = s_dropped = false;
    s_reason = 0;
    bootloader_random_enable();
    ESP_LOGI(TAG, "NET Wi-Fi radio off");
  }
#endif
}

static void set_station(bool want) {
  if (want == s_sta_wanted) return;
  s_sta_wanted = want;
  ESP_LOGI(TAG, "NET Wi-Fi %s", want ? "on" : "off (the cable carries the phone)");
#if !CONFIG_OLP_QEMU
  if (s_radio && want && s_ssid[0]) esp_wifi_connect();
  if (s_radio && !want) esp_wifi_disconnect();
  radio_apply();
#endif
}

static ns_input_t sel_input(bool busy) {
  return (ns_input_t){.wired = eth_present(), .has_wifi = s_ssid[0] != '\0', .busy = busy};
}

static const char *uplink_name(net_uplink_t u) {
  return u == NET_WIRED ? "wired" : u == NET_WIFI ? "wifi" : "none";
}

net_change_t net_select(int ev, bool busy) {
  ns_input_t in = sel_input(busy);
  net_uplink_t before = s_sel.uplink;
  bool was_settled = s_sel.settled;
  netsel_step(&s_sel, (ns_event_t)ev, &in, now_ms());
  if (s_sel.settled && !was_settled)
    ESP_LOGI(TAG, "NET settled: %s", !in.wired              ? "Wi-Fi only (no wired network)"
                                     : s_sel.uplink == NET_WIRED ? "the cable"
                                     : in.has_wifi             ? "Wi-Fi (no usable cable)"
                                                               : "waiting for a cable");
  eth_phy(s_sel.phy_on);
  set_station(s_sel.wifi_on);
  if (s_sel.uplink == before) return NET_SAME;
  // The chosen network is the default route (both can have an address while a call finishes).
  void *netif = s_sel.uplink == NET_WIRED ? eth_netif() : s_sel.uplink == NET_WIFI ? s_netif : NULL;
  if (netif) esp_netif_set_default_netif(netif);
  char ip[16];
  net_uplink_ip(ip, sizeof ip);
  const char *why = s_sel.uplink == NET_NONE ? net_problem() : NULL;
  ESP_LOGI(TAG, "NET uplink %s%s%s%s%s", uplink_name(s_sel.uplink), ip[0] ? " ip=" : "", ip,
           why ? ": " : "", why ? why : "");
  if (s_sel.uplink == NET_NONE) return NET_WENT_DOWN;
  net_change_t c =
      s_last_used != NET_NONE && s_last_used != s_sel.uplink ? NET_SWITCHED : NET_WENT_UP;
  s_last_used = s_sel.uplink;
  return c;
}

bool net_settled(void) { return s_sel.settled; }
net_uplink_t net_uplink(void) { return s_sel.uplink; }
bool net_up(void) { return s_sel.uplink != NET_NONE; }
bool net_wired(void) { return eth_present(); }

const char *net_problem(void) {
  ns_input_t in = sel_input(false);
  return netsel_problem(&s_sel, &in, s_wifi_up ? NULL : net_wifi_problem());
}

const char *net_cable_line(void) {
  ns_input_t in = sel_input(false);
  return netsel_cable_text(netsel_cable(&s_sel, &in));
}

void net_setup_radio(bool on) {
  s_ap_on = on;
  radio_apply();
}
#else
// --- rev A: Wi-Fi only ---------------------------------------------------------------------------
net_change_t net_select(int ev, bool busy) {
  (void)ev;
  (void)busy;
  return NET_SAME;
}
bool net_settled(void) { return true; }
net_uplink_t net_uplink(void) { return s_wifi_up ? NET_WIFI : NET_NONE; }
bool net_up(void) { return s_wifi_up; }
bool net_wired(void) { return false; }
const char *net_problem(void) { return s_wifi_up ? NULL : net_wifi_problem(); }
const char *net_cable_line(void) { return NULL; }
void net_setup_radio(bool on) { (void)on; }
#endif

void net_uplink_ip(char *ip, size_t n) {
  ip[0] = '\0';
  if (net_uplink() == NET_WIRED) {
    eth_info_t e;
    eth_info(&e);
    snprintf(ip, n, "%s", e.ip);
  } else if (net_uplink() == NET_WIFI && s_netif) {
    esp_netif_ip_info_t info;
    if (esp_netif_get_ip_info(s_netif, &info) == ESP_OK) snprintf(ip, n, IPSTR, IP2STR(&info.ip));
  }
}

void net_start(void) {
  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
#if CONFIG_OLP_QEMU && BOARD_HAS_ETHERNET
  // QEMU for hw v0.901: its Ethernet is the cable (eth.c) and there is no Wi-Fi radio. The saved
  // Wi-Fi still counts for the choice (sdkconfig.qemu names one): the phone then powers the
  // "PHY" down and looks for the cable now and then, as on the board.
  nvs_str("ssid", s_ssid, sizeof s_ssid, CONFIG_OLP_WIFI_SSID);
  ESP_LOGI(TAG, "saved Wi-Fi: %s (QEMU: no radio; its Ethernet is the cable)",
           s_ssid[0] ? s_ssid : "(none)");
  netsel_init(&s_sel, now_ms());
  eth_start();
  net_select(NS_TICK, false);
#elif CONFIG_OLP_QEMU
  start_qemu_ethernet();
#endif
#if CONFIG_OLP_QEMU
  (void)wifi_event;  // no Wi-Fi driver in QEMU
  (void)retry_now;
  (void)apply_wifi;
#else
  s_netif = esp_netif_create_default_wifi_sta();
  wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&init));
  ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL));
  ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL));
  const esp_timer_create_args_t t = {.callback = retry_now, .name = "wifi_retry"};
  ESP_ERROR_CHECK(esp_timer_create(&t, &s_retry));
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  apply_wifi();
#if BOARD_HAS_ETHERNET
  // The cable first: the radio stays off until the network choice wants Wi-Fi (or the setup
  // network opens). Until then the SAR ADC is the random number generator's entropy source.
  bootloader_random_enable();
  netsel_init(&s_sel, now_ms());
  eth_start();
  net_select(NS_TICK, false);  // no W5500 answering: straight to Wi-Fi
#else
  ESP_ERROR_CHECK(esp_wifi_start());
  // The phone is always plugged in: no modem sleep. Sleeping between beacons (DTIM) let the
  // router drop it for missed acknowledgements (reason 34) and adds jitter to call audio.
  esp_err_t ps = esp_wifi_set_ps(WIFI_PS_NONE);
  if (ps != ESP_OK) ESP_LOGW(TAG, "wifi power save stays on: %s", esp_err_to_name(ps));
#endif
#endif
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
#if BOARD_HAS_ETHERNET
  apply_wifi();
  if (s_radio && s_sta_wanted) {
    esp_wifi_disconnect();
    esp_wifi_connect();
  }
  app_post(EV_NET, NS_TICK, NULL);  // a Wi-Fi to fall back on now (or none): choose again
  return;
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

void net_ws_stop(void) {
  if (!s_ws) return;
  // Connected or waiting to reconnect, the client stops: no quick reconnects until opened again.
  if (esp_websocket_client_is_connected(s_ws)) esp_websocket_client_close(s_ws, pdMS_TO_TICKS(2000));
  else esp_websocket_client_stop(s_ws);
}

bool net_ws_send(const char *text) {
  if (!s_ws || !esp_websocket_client_is_connected(s_ws)) return false;
  return esp_websocket_client_send_text(s_ws, text, strlen(text), pdMS_TO_TICKS(5000)) >= 0;
}
