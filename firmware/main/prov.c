#include "prov.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app.h"
#include "esp_http_client.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "net.h"
#include "prov_core.h"
#include "sdkconfig.h"

static const char *TAG = "prov";
#define MAX_APS 16
#define AP_IP "192.168.4.1"

static bool s_active;
static char s_ssid[33], s_pass[9];
static esp_netif_t *s_ap_netif;
static httpd_handle_t s_httpd;
static TaskHandle_t s_dns_task;
static volatile bool s_dns_run;
static int s_dns_sock = -1;
static prov_ap_t s_aps[MAX_APS];
static int s_naps;

const char *prov_ssid(void) { return s_ssid; }
const char *prov_password(void) { return s_pass; }
bool prov_ap_active(void) { return s_active; }

// --- scanning ---------------------------------------------------------------------------------

static void scan(void) {
#if CONFIG_OLP_QEMU
  return;
#endif
  wifi_scan_config_t cfg = {.show_hidden = false};
  if (esp_wifi_scan_start(&cfg, true) != ESP_OK) {
    ESP_LOGW(TAG, "scan failed");
    return;
  }
  uint16_t n = MAX_APS;
  wifi_ap_record_t *recs = calloc(MAX_APS, sizeof *recs);
  if (!recs) return;
  if (esp_wifi_scan_get_ap_records(&n, recs) == ESP_OK) {
    s_naps = 0;
    for (int i = 0; i < n && s_naps < MAX_APS; i++) {
      prov_ap_t *a = &s_aps[s_naps++];
      snprintf(a->ssid, sizeof a->ssid, "%.32s", (const char *)recs[i].ssid);
      a->rssi = recs[i].rssi;
      a->secure = recs[i].authmode != WIFI_AUTH_OPEN;
    }
    s_naps = prov_scan_tidy(s_aps, s_naps);
  }
  free(recs);
  ESP_LOGI(TAG, "scan: %d networks", s_naps);
}

// --- the setup site -------------------------------------------------------------------------

/** Only the setup network (and the phone itself) may use the setup site, not the home LAN. */
static bool from_setup_network(httpd_req_t *req) {
  struct sockaddr_storage local;
  socklen_t len = sizeof local;
  if (getsockname(httpd_req_to_sockfd(req), (struct sockaddr *)&local, &len) != 0) return false;
  uint32_t ip;
  if (local.ss_family == AF_INET) {
    ip = ((struct sockaddr_in *)&local)->sin_addr.s_addr;
  } else if (local.ss_family == AF_INET6) {
    // The server listens dual-stack: IPv4 clients arrive as ::ffff:a.b.c.d.
    const uint8_t *b = ((const struct sockaddr_in6 *)&local)->sin6_addr.s6_addr;
    static const uint8_t prefix[12] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff};
    if (memcmp(b, prefix, 12)) return false;
    memcpy(&ip, b + 12, 4);
  } else {
    return false;
  }
#if CONFIG_OLP_QEMU
  (void)ip;
  return true;  // QEMU has no setup network: its Ethernet (host-forwarded port) stands in
#else
  return ip == inet_addr(AP_IP) || ip == inet_addr("127.0.0.1");
#endif
}

static esp_err_t redirect(httpd_req_t *req) {
  httpd_resp_set_status(req, "302 Found");
  httpd_resp_set_hdr(req, "Location", "http://" AP_IP "/");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  return httpd_resp_send(req, NULL, 0);
}

static const char HEAD[] =
    "<!doctype html><html lang=en><head><meta charset=utf-8>"
    "<meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>Open Lounge Phone setup</title><style>"
    "body{font:18px/1.4 system-ui,sans-serif;max-width:26em;margin:0 auto;padding:16px;"
    "color:#222;background:#fbf8f1}h1{font-size:1.4em}label{display:block;margin:.4em 0}"
    ".net{padding:.5em;border:1px solid #ccc;border-radius:8px;background:#fff}"
    "input[type=text],input[type=password]{width:100%;box-sizing:border-box;font-size:1em;"
    "padding:.5em}button{font-size:1.1em;padding:.6em 1.2em;margin-top:.8em}"
    ".err{color:#a00;font-weight:bold}small{color:#666}</style></head><body>";

static void send_page(httpd_req_t *req, const char *error) {
  httpd_resp_set_type(req, "text/html; charset=utf-8");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  httpd_resp_sendstr_chunk(req, HEAD);
  httpd_resp_sendstr_chunk(req, "<h1>Set up your phone</h1><p>Choose the Wi-Fi this phone uses.</p>");
  if (error) {
    char esc[200];
    prov_html_escape(error, esc, sizeof esc);
    httpd_resp_sendstr_chunk(req, "<p class=err>");
    httpd_resp_sendstr_chunk(req, esc);
    httpd_resp_sendstr_chunk(req, "</p>");
  }
  httpd_resp_sendstr_chunk(req, "<form method=post action=/save>");
  char line[512], esc[200];
  for (int i = 0; i < s_naps; i++) {
    prov_html_escape(s_aps[i].ssid, esc, sizeof esc);
    int bars = s_aps[i].rssi > -55 ? 4 : s_aps[i].rssi > -67 ? 3 : s_aps[i].rssi > -78 ? 2 : 1;
    snprintf(line, sizeof line,
             "<label class=net><input type=radio name=ssid value=\"%s\"%s> %s "
             "<small>%.*s%s</small></label>",
             esc, i == 0 ? " checked" : "", esc, bars, "||||", s_aps[i].secure ? "" : " open");
    httpd_resp_sendstr_chunk(req, line);
  }
  if (s_naps == 0) httpd_resp_sendstr_chunk(req, "<p>No networks found.</p>");
  httpd_resp_sendstr_chunk(
      req,
      "<label>Or type its name<input type=text name=other maxlength=32 autocapitalize=none "
      "autocorrect=off></label><label>Password<input type=password name=pass maxlength=64>"
      "</label><button>Save and restart</button></form><p><a href='/?scan=1'>Scan again</a>"
      "</p><p><small>Open Lounge Phone</small></p></body></html>");
  httpd_resp_sendstr_chunk(req, NULL);
}

static esp_err_t get_root(httpd_req_t *req) {
  if (!from_setup_network(req)) return httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "setup only");
  char q[16];
  if (httpd_req_get_url_query_str(req, q, sizeof q) == ESP_OK && strstr(q, "scan=1")) scan();
  send_page(req, NULL);
  return ESP_OK;
}

static void reboot_task(void *arg) {
  vTaskDelay(pdMS_TO_TICKS(1500));  // let the "saved" page reach the browser
  app_post(EV_PROV_SAVED, 0, NULL);
  vTaskDelete(NULL);
}

static esp_err_t post_save(httpd_req_t *req) {
  if (!from_setup_network(req)) return httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "setup only");
  if (req->content_len > 512) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "too long");
  char body[513];
  int got = 0;
  while (got < (int)req->content_len) {
    int r = httpd_req_recv(req, body + got, req->content_len - got);
    if (r <= 0) return ESP_FAIL;
    got += r;
  }
  body[got] = '\0';
  char ssid[65] = "", other[65] = "", pass[80] = "";
  prov_form_get(body, "ssid", ssid, sizeof ssid);
  prov_form_get(body, "other", other, sizeof other);
  if (prov_form_get(body, "pass", pass, sizeof pass) < 0) pass[0] = '\0';
  const char *name = other[0] ? other : ssid;
  const char *err = prov_check(name, pass);
  if (err) {
    ESP_LOGW(TAG, "setup page: %s", err);
    send_page(req, err);
    return ESP_OK;
  }
  net_save_wifi(name, pass);
  ESP_LOGI(TAG, "PROV SAVED ssid=%s (restarting)", name);
  char esc[200], line[512];
  prov_html_escape(name, esc, sizeof esc);
  httpd_resp_set_type(req, "text/html; charset=utf-8");
  httpd_resp_sendstr_chunk(req, HEAD);
  snprintf(line, sizeof line,
           "<h1>Saved</h1><p>The phone restarts and joins <b>%s</b>. Its display shows when it "
           "is online; then pair it in the Open Lounge Phone app.</p></body></html>",
           esc);
  httpd_resp_sendstr_chunk(req, line);
  httpd_resp_sendstr_chunk(req, NULL);
  xTaskCreate(reboot_task, "prov_reboot", 2048, NULL, 5, NULL);
  return ESP_OK;
}

/** Everything else (the OS captive-portal checks included) goes to the setup page. */
static esp_err_t not_found(httpd_req_t *req, httpd_err_code_t err) { return redirect(req); }

static void start_http(void) {
  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  cfg.max_open_sockets = 5;
  cfg.lru_purge_enable = true;
  cfg.stack_size = 6144;
  if (httpd_start(&s_httpd, &cfg) != ESP_OK) {
    ESP_LOGE(TAG, "http server failed");
    return;
  }
  const httpd_uri_t root = {.uri = "/", .method = HTTP_GET, .handler = get_root};
  const httpd_uri_t save = {.uri = "/save", .method = HTTP_POST, .handler = post_save};
  httpd_register_uri_handler(s_httpd, &root);
  httpd_register_uri_handler(s_httpd, &save);
  httpd_register_err_handler(s_httpd, HTTPD_404_NOT_FOUND, not_found);
}

// --- captive DNS ----------------------------------------------------------------------------

static void dns_task(void *arg) {
  uint8_t q[512], r[540];
  uint32_t ip = inet_addr(AP_IP);
  while (s_dns_run) {
    struct sockaddr_in from;
    socklen_t fl = sizeof from;
    int n = recvfrom(s_dns_sock, q, sizeof q, 0, (struct sockaddr *)&from, &fl);
    if (n <= 0) continue;  // timeout: check s_dns_run
    size_t len = prov_dns_answer(q, (size_t)n, r, sizeof r, ip);
    if (len) sendto(s_dns_sock, r, len, 0, (struct sockaddr *)&from, fl);
  }
  close(s_dns_sock);
  s_dns_sock = -1;
  s_dns_task = NULL;
  vTaskDelete(NULL);
}

static void start_dns(void) {
  s_dns_sock = socket(AF_INET, SOCK_DGRAM, 0);
  if (s_dns_sock < 0) return;
  struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(53)};
  a.sin_addr.s_addr = inet_addr(AP_IP);
  struct timeval tv = {.tv_sec = 1};
  setsockopt(s_dns_sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  if (bind(s_dns_sock, (struct sockaddr *)&a, sizeof a) != 0) {
    ESP_LOGW(TAG, "dns bind failed");
    close(s_dns_sock);
    s_dns_sock = -1;
    return;
  }
  s_dns_run = true;
  xTaskCreate(dns_task, "prov_dns", 3072, NULL, 4, &s_dns_task);
}

// --- start / stop ---------------------------------------------------------------------------

void prov_start_ap(void) {
  if (s_active) return;
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
  prov_ap_ssid(mac, s_ssid, sizeof s_ssid);
  prov_ap_password(esp_random(), s_pass);
  s_active = true;
#if CONFIG_OLP_QEMU
  // No Wi-Fi in QEMU: the setup site runs on its Ethernet (tools/qemu.sh QEMU_HOSTFWD).
  start_http();
  ESP_LOGI(TAG, "PROV AP UP ssid=%s (QEMU: no radio; the setup site is on the Ethernet)", s_ssid);
  return;
#else
  if (!s_ap_netif) s_ap_netif = esp_netif_create_default_wifi_ap();
  net_slow_retry(true);
  esp_wifi_set_mode(WIFI_MODE_APSTA);
  wifi_config_t ap = {
      .ap =
          {
              .channel = 0,  // follow the station's channel
              .max_connection = 2,
              .authmode = WIFI_AUTH_WPA2_PSK,
              .pmf_cfg = {.required = false},
          },
  };
  memcpy(ap.ap.ssid, s_ssid, strlen(s_ssid));
  ap.ap.ssid_len = (uint8_t)strlen(s_ssid);
  memcpy(ap.ap.password, s_pass, strlen(s_pass));
  esp_err_t err = esp_wifi_set_config(WIFI_IF_AP, &ap);
  if (err != ESP_OK) ESP_LOGE(TAG, "AP config failed: %s", esp_err_to_name(err));
  scan();
  start_dns();
  start_http();
  // The password is on the display for whoever holds the phone; the log shows the name only.
  ESP_LOGI(TAG, "PROV AP UP ssid=%s http://" AP_IP "/", s_ssid);
#endif
}

void prov_stop_ap(void) {
  if (!s_active) return;
  if (s_httpd) httpd_stop(s_httpd);
  s_httpd = NULL;
  s_dns_run = false;
#if !CONFIG_OLP_QEMU
  esp_wifi_set_mode(WIFI_MODE_STA);
  net_slow_retry(false);
#endif
  s_active = false;
  ESP_LOGI(TAG, "PROV AP DOWN");
}

// --- self test ------------------------------------------------------------------------------

static int http(const char *path, const char *body, char *out, int outlen) {
  char url[64];
  snprintf(url, sizeof url, "http://127.0.0.1%s", path);
  esp_http_client_config_t cfg = {.url = url, .timeout_ms = 20000, .disable_auto_redirect = true};
  esp_http_client_handle_t c = esp_http_client_init(&cfg);
  if (body) {
    esp_http_client_set_method(c, HTTP_METHOD_POST);
    esp_http_client_set_header(c, "Content-Type", "application/x-www-form-urlencoded");
  }
  int status = -1, total = 0;
  if (esp_http_client_open(c, body ? (int)strlen(body) : 0) == ESP_OK) {
    if (body) esp_http_client_write(c, body, (int)strlen(body));
    esp_http_client_fetch_headers(c);
    status = esp_http_client_get_status_code(c);
    int r;
    while (total < outlen - 1 && (r = esp_http_client_read(c, out + total, outlen - 1 - total)) > 0)
      total += r;
  }
  out[total > 0 ? total : 0] = '\0';
  esp_http_client_cleanup(c);
  return status;
}

void prov_selftest(const char *save_ssid, const char *save_pass) {
  if (!s_active) {
    printf("PROV TEST FAIL: the setup network is not open (`setup` first)\n");
    return;
  }
  char *buf = malloc(4096);
  if (!buf) return;
  int st = http("/", NULL, buf, 4096);
  printf("PROV TEST GET / %d %s networks=%d\n", st,
         strstr(buf, "action=/save") ? "form" : "NO-FORM", s_naps);
  st = http("/generate_204", NULL, buf, 4096);
  printf("PROV TEST GET /generate_204 %d (captive redirect)\n", st);
  st = http("/save", "ssid=&pass=short", buf, 4096);
  printf("PROV TEST POST bad %d %s\n", st, strstr(buf, "class=err") ? "error-shown" : "NO-ERROR");
  if (save_ssid) {
    char body[200], ssid_enc[100] = "", pass_enc[100] = "";
    // Form-encode (spaces and specials) like a browser would.
    for (const char *s = save_ssid; *s && strlen(ssid_enc) < sizeof ssid_enc - 4; s++) {
      char e[4];
      snprintf(e, sizeof e, (*s == '-' || *s == '_' || (*s >= '0' && *s <= '9') ||
                             (*s >= 'A' && *s <= 'Z') || (*s >= 'a' && *s <= 'z'))
                                ? "%c"
                                : "%%%02X",
               (unsigned char)*s);
      strlcat(ssid_enc, e, sizeof ssid_enc);
    }
    for (const char *s = save_pass ? save_pass : ""; *s && strlen(pass_enc) < sizeof pass_enc - 4; s++) {
      char e[4];
      snprintf(e, sizeof e, "%%%02X", (unsigned char)*s);
      strlcat(pass_enc, e, sizeof pass_enc);
    }
    snprintf(body, sizeof body, "ssid=%s&other=&pass=%s", ssid_enc, pass_enc);
    st = http("/save", body, buf, 4096);
    printf("PROV TEST POST save %d %s\n", st, strstr(buf, "<h1>Saved</h1>") ? "saved" : "NOT-SAVED");
  }
  free(buf);
}
