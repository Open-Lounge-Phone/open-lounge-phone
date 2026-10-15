#include "check.h"
#include "prov_core.h"

TEST(prov_first_boot_opens_setup) {
  prov_t p;
  prov_init(&p);
  CHECK(prov_step(&p, PROV_EV_BOOT, false, false, 0) == PROV_ACT_START_AP);
  CHECK(p.ap_on);
  // A link without saved Wi-Fi (QEMU's Ethernet) doesn't close it: only saving does.
  CHECK(prov_step(&p, PROV_EV_STA_UP, false, false, 1000) == PROV_ACT_NONE);
  CHECK(p.ap_on);
  // Nothing saved yet: joining some network can't happen, ticks keep it open.
  CHECK(prov_step(&p, PROV_EV_TICK, false, false, 10 * 60 * 1000) == PROV_ACT_NONE);
  CHECK(prov_step(&p, PROV_EV_SAVED, true, false, 11 * 60 * 1000) == PROV_ACT_REBOOT);
}

TEST(prov_saved_wifi_boots_quietly) {
  prov_t p;
  prov_init(&p);
  CHECK(prov_step(&p, PROV_EV_BOOT, true, false, 0) == PROV_ACT_NONE);
  CHECK(!p.ap_on);
  CHECK(prov_step(&p, PROV_EV_STA_UP, true, false, 5000) == PROV_ACT_NONE);
  CHECK(prov_step(&p, PROV_EV_TICK, true, false, PROV_FALLBACK_MS * 2) == PROV_ACT_NONE);
}

TEST(prov_keys_at_boot_force_setup_even_with_wifi) {
  prov_t p;
  prov_init(&p);
  CHECK(prov_step(&p, PROV_EV_BOOT, true, true, 0) == PROV_ACT_START_AP);
  // Asked for: joining the old network doesn't close it.
  CHECK(prov_step(&p, PROV_EV_STA_UP, true, true, 1000) == PROV_ACT_NONE);
  CHECK(p.ap_on);
}

TEST(prov_unreachable_wifi_falls_back_after_3_minutes) {
  prov_t p;
  prov_init(&p);
  prov_step(&p, PROV_EV_BOOT, true, false, 0);
  CHECK(prov_step(&p, PROV_EV_TICK, true, false, PROV_FALLBACK_MS - 1) == PROV_ACT_NONE);
  CHECK(prov_step(&p, PROV_EV_TICK, true, false, PROV_FALLBACK_MS) == PROV_ACT_START_AP);
  CHECK(prov_step(&p, PROV_EV_TICK, true, false, PROV_FALLBACK_MS + 1) == PROV_ACT_NONE);  // once
  // The network comes back: the fallback setup network closes.
  CHECK(prov_step(&p, PROV_EV_STA_UP, true, false, PROV_FALLBACK_MS + 5000) == PROV_ACT_STOP_AP);
  CHECK(!p.ap_on);
}

TEST(prov_dropouts_restart_the_fallback_clock) {
  prov_t p;
  prov_init(&p);
  prov_step(&p, PROV_EV_BOOT, true, false, 0);
  prov_step(&p, PROV_EV_STA_UP, true, false, 1000);
  prov_step(&p, PROV_EV_STA_DOWN, true, false, 100000);
  prov_step(&p, PROV_EV_STA_DOWN, true, false, 150000);  // repeated retries keep the first time
  CHECK(prov_step(&p, PROV_EV_TICK, true, false, 100000 + PROV_FALLBACK_MS - 1) == PROV_ACT_NONE);
  CHECK(prov_step(&p, PROV_EV_TICK, true, false, 100000 + PROV_FALLBACK_MS) == PROV_ACT_START_AP);
}

TEST(prov_open_from_menu) {
  prov_t p;
  prov_init(&p);
  prov_step(&p, PROV_EV_BOOT, true, false, 0);
  prov_step(&p, PROV_EV_STA_UP, true, false, 1000);
  CHECK(prov_step(&p, PROV_EV_OPEN, true, false, 2000) == PROV_ACT_START_AP);
  CHECK(prov_step(&p, PROV_EV_OPEN, true, false, 3000) == PROV_ACT_NONE);
}

// hw v0.901: a working cable is a network, so setup doesn't demand Wi-Fi.
TEST(prov_a_working_cable_at_power_on_needs_no_setup) {
  prov_t p;
  prov_init(&p);
  // The app boots setup only once the network choice is made; a cable counts as a network.
  CHECK(prov_step(&p, PROV_EV_BOOT, true /* cable */, false, 0) == PROV_ACT_NONE);
  CHECK(prov_step(&p, PROV_EV_WIRED_UP, true, false, 100) == PROV_ACT_NONE);
  CHECK(prov_step(&p, PROV_EV_TICK, true, false, PROV_FALLBACK_MS * 3) == PROV_ACT_NONE);
}

TEST(prov_a_cable_closes_the_setup_network_opened_for_lack_of_one) {
  prov_t p;
  prov_init(&p);
  CHECK(prov_step(&p, PROV_EV_BOOT, false, false, 0) == PROV_ACT_START_AP);  // nothing at all
  // Wi-Fi coming up wouldn't close it (only saving does); a cable does: it is the network.
  CHECK(prov_step(&p, PROV_EV_WIRED_UP, false, false, 1000) == PROV_ACT_STOP_AP);
  CHECK(!p.ap_on);
  // Unplugged for good: setup is offered again after the fallback time.
  prov_step(&p, PROV_EV_STA_DOWN, false, false, 2000);
  CHECK(prov_step(&p, PROV_EV_TICK, false, false, 2000 + PROV_FALLBACK_MS) == PROV_ACT_START_AP);
  // …and the cable back closes it again.
  CHECK(prov_step(&p, PROV_EV_WIRED_UP, false, false, 3000 + PROV_FALLBACK_MS) == PROV_ACT_STOP_AP);
}

TEST(prov_a_cable_never_closes_setup_someone_asked_for) {
  prov_t p;
  prov_init(&p);
  CHECK(prov_step(&p, PROV_EV_BOOT, true, true /* MENU+BACK */, 0) == PROV_ACT_START_AP);
  CHECK(prov_step(&p, PROV_EV_WIRED_UP, true, false, 1000) == PROV_ACT_NONE);
  CHECK(p.ap_on);
  prov_init(&p);
  prov_step(&p, PROV_EV_BOOT, true, false, 0);
  prov_step(&p, PROV_EV_WIRED_UP, true, false, 500);
  CHECK(prov_step(&p, PROV_EV_OPEN, true, false, 1000) == PROV_ACT_START_AP);  // MENU 4 -> 1
  CHECK(prov_step(&p, PROV_EV_WIRED_UP, true, false, 2000) == PROV_ACT_NONE);
  CHECK(p.ap_on);
  CHECK(prov_step(&p, PROV_EV_SAVED, true, false, 3000) == PROV_ACT_REBOOT);
}

TEST(prov_wifi_is_optional_with_a_cable) {
  CHECK(prov_wifi_answer("Home", false, false) == PROV_WIFI_SAVE);
  CHECK(prov_wifi_answer("Home", true, true) == PROV_WIFI_SAVE);
  CHECK(prov_wifi_answer("", true, false) == PROV_WIFI_KEEP);   // keep the saved network
  CHECK(prov_wifi_answer("", false, true) == PROV_WIFI_KEEP);   // none, on the cable
  CHECK(prov_wifi_answer("", false, false) == PROV_WIFI_MISSING);
  CHECK(prov_wifi_answer(NULL, false, false) == PROV_WIFI_MISSING);
  CHECK(prov_check("", "") != NULL);  // what the page says when it's missing
}

TEST(prov_names) {
  uint8_t mac[6] = {0x24, 0x6f, 0x28, 0x01, 0xab, 0x0c};
  char ssid[33];
  prov_ap_ssid(mac, ssid, sizeof ssid);
  CHECK_STR(ssid, "OpenLoungePhone-AB0C");
  char pw[9];
  prov_ap_password(123, pw);
  CHECK_STR(pw, "00000123");
  prov_ap_password(4294967295u, pw);
  CHECK(strlen(pw) == 8);
}

TEST(prov_form_decoding) {
  char v[65];
  const char *body = "ssid=My+Home%20Wi-Fi%21&pass=p%26ss%3Dword&empty=&flag";
  CHECK(prov_form_get(body, "ssid", v, sizeof v) == 14);
  CHECK_STR(v, "My Home Wi-Fi!");
  CHECK(prov_form_get(body, "pass", v, sizeof v) == 9);
  CHECK_STR(v, "p&ss=word");
  CHECK(prov_form_get(body, "empty", v, sizeof v) == 0);
  CHECK(prov_form_get(body, "flag", v, sizeof v) == 0);
  CHECK(prov_form_get(body, "missing", v, sizeof v) == PROV_FORM_MISSING);
  CHECK(prov_form_get(body, "ss", v, sizeof v) == PROV_FORM_MISSING);  // no prefix matches
  // Too long for the buffer, bad escapes and encoded NULs are refused, and told apart from missing.
  char small[4];
  CHECK(prov_form_get("ssid=abcdef", "ssid", small, sizeof small) == PROV_FORM_BAD);
  CHECK(prov_form_get("ssid=%zz", "ssid", v, sizeof v) == PROV_FORM_BAD);
  CHECK(prov_form_get("ssid=%4", "ssid", v, sizeof v) == PROV_FORM_BAD);
  CHECK(prov_form_get("ssid=a%00b", "ssid", v, sizeof v) == PROV_FORM_BAD);
}

static const char *or_none(const char *s) { return s ? s : "(none)"; }

TEST(prov_form_answers_never_drop_a_field) {
  prov_answers_t a;
  CHECK(prov_form_answers("ssid=Home&other=&pass=secret12&srv=own&addr=phone.example.com", &a) ==
        NULL);
  CHECK_STR(a.ssid, "Home");
  CHECK_STR(a.other, "");
  CHECK_STR(a.pass, "secret12");
  CHECK_STR(a.srv, "own");
  CHECK_STR(a.addr, "phone.example.com");
  // A typed name longer than the phone stores (32 bytes) is an error, not a silent switch to the
  // network picked above it: "é" is 2 bytes, so 17 of them are 34.
  char body[512] = "ssid=Home&other=";
  for (int i = 0; i < 17; i++) strcat(body, "%C3%A9");
  strcat(body, "&pass=secret12");
  CHECK_STR(or_none(prov_form_answers(body, &a)), "That network name is too long.");
  CHECK_STR(a.ssid, "");
  // 32 bytes fit.
  CHECK(prov_form_answers("other=12345678901234567890123456789012&pass=secret12", &a) == NULL);
  CHECK_STR(a.other, "12345678901234567890123456789012");
  // A password over 64 characters, an address over the box.
  char pass[128] = "ssid=Home&pass=";
  for (int i = 0; i < 65; i++) strcat(pass, "a");
  CHECK_STR(or_none(prov_form_answers(pass, &a)), "That password is too long.");
  char addr[512] = "srv=own&addr=";
  for (int i = 0; i < 160; i++) strcat(addr, "a");
  CHECK_STR(or_none(prov_form_answers(addr, &a)), "That address is too long.");
  // Missing fields read as empty.
  CHECK(prov_form_answers("", &a) == NULL);
  CHECK_STR(a.srv, "");
}

TEST(prov_checks) {
  CHECK(prov_check("", "") != NULL);
  CHECK(prov_check("home", "") == NULL);  // open network
  CHECK(prov_check("home", "short") != NULL);
  CHECK(prov_check("home", "longenough") == NULL);
  CHECK(prov_check("123456789012345678901234567890123", "longenough") != NULL);  // 33 bytes
  char hex64[65];
  memset(hex64, 'a', 64);
  hex64[64] = '\0';
  CHECK(prov_check("home", hex64) == NULL);
  hex64[10] = 'z';
  CHECK(strstr(or_none(prov_check("home", hex64)), "0-9 and a-f") != NULL);
}

TEST(prov_scan_sorting) {
  prov_ap_t aps[5] = {
      {"Weak", -80, true}, {"", -30, true}, {"Home", -50, true}, {"Home", -40, true}, {"Cafe", -60, false},
  };
  int n = prov_scan_tidy(aps, 5);
  CHECK(n == 3);
  CHECK_STR(aps[0].ssid, "Home");
  CHECK(aps[0].rssi == -40);
  CHECK_STR(aps[1].ssid, "Cafe");
  CHECK_STR(aps[2].ssid, "Weak");
}

TEST(prov_html_escaping) {
  char out[64];
  prov_html_escape("<a href=\"x\">Tom & Jerry's</a>", out, sizeof out);
  CHECK_STR(out, "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;");
  char tiny[8];
  CHECK(prov_html_escape("a&b&c", tiny, sizeof tiny) == 7);  // "a&amp;b", then no room
  CHECK_STR(tiny, "a&amp;b");
}

static size_t query(uint8_t *q, const char *name, uint16_t qtype) {
  memset(q, 0, 12);
  q[0] = 0x12; q[1] = 0x34;  // id
  q[2] = 0x01;               // RD
  q[5] = 1;                  // QDCOUNT
  size_t i = 12;
  const char *p = name;
  while (*p) {
    const char *dot = strchr(p, '.');
    size_t len = dot ? (size_t)(dot - p) : strlen(p);
    q[i++] = (uint8_t)len;
    memcpy(q + i, p, len);
    i += len;
    p += len + (dot ? 1 : 0);
  }
  q[i++] = 0;
  q[i++] = (uint8_t)(qtype >> 8);
  q[i++] = (uint8_t)qtype;
  q[i++] = 0;
  q[i++] = 1;
  return i;
}

TEST(prov_dns_answers_everything_with_our_ip) {
  uint8_t q[128], r[160];
  size_t qlen = query(q, "connectivitycheck.gstatic.com", 1);
  uint32_t ip = 0x0104A8C0;  // 192.168.4.1 in network order on a little-endian host
  size_t n = prov_dns_answer(q, qlen, r, sizeof r, ip);
  CHECK(n == qlen + 16);
  CHECK(r[0] == 0x12 && r[1] == 0x34);  // same id
  CHECK(r[2] & 0x80);                   // a response
  CHECK((r[3] & 0x0F) == 0);            // no error
  CHECK(r[7] == 1);                     // one answer
  CHECK(r[qlen] == 0xC0 && r[qlen + 1] == 12);
  CHECK(r[qlen + 12] == 192 && r[qlen + 13] == 168 && r[qlen + 14] == 4 && r[qlen + 15] == 1);
}

TEST(prov_dns_edge_cases) {
  uint8_t q[128], r[160];
  size_t qlen = query(q, "example.com", 28);  // AAAA: an empty answer, not an error
  size_t n = prov_dns_answer(q, qlen, r, sizeof r, 0x0104A8C0);
  CHECK(n == qlen && r[7] == 0);
  CHECK(prov_dns_answer(q, 5, r, sizeof r, 0) == 0);  // too short
  q[2] |= 0x80;                                        // a response, not a query
  CHECK(prov_dns_answer(q, qlen, r, sizeof r, 0) == 0);
  qlen = query(q, "example.com", 1);
  q[12] = 0xC0;  // compression in the question: refused
  CHECK(prov_dns_answer(q, qlen, r, sizeof r, 0) == 0);
  qlen = query(q, "example.com", 1);
  CHECK(prov_dns_answer(q, qlen, r, qlen + 8, 0) == 0);  // no room for the answer
  q[12] = 60;  // a label running past the end
  CHECK(prov_dns_answer(q, qlen, r, sizeof r, 0) == 0);
}

TEST(prov_boot_hold_thresholds) {
  CHECK(prov_boot_hold(0) == PROV_HOLD_NONE);
  CHECK(prov_boot_hold(2999) == PROV_HOLD_NONE);   // a brief press at power-on does nothing
  CHECK(prov_boot_hold(3000) == PROV_HOLD_SETUP);
  CHECK(prov_boot_hold(9999) == PROV_HOLD_SETUP);
  CHECK(prov_boot_hold(10000) == PROV_HOLD_RESET);
  CHECK(prov_boot_hold(60000) == PROV_HOLD_RESET);
}

TEST(prov_server_address_forms) {
  char u[PROV_SERVER_MAX];
  CHECK(prov_server_url("phone.example.com", u, sizeof u) == NULL);
  CHECK_STR(u, "wss://phone.example.com");
  CHECK(prov_server_url("  https://Phone.Example.com/  ", u, sizeof u) == NULL);
  CHECK_STR(u, "wss://phone.example.com");
  CHECK(prov_server_url("WSS://phone.example.com:8443/olp/", u, sizeof u) == NULL);
  CHECK_STR(u, "wss://phone.example.com:8443/olp");
  CHECK(prov_server_url("http://192.168.1.5:8787", u, sizeof u) == NULL);  // a local test server
  CHECK_STR(u, "ws://192.168.1.5:8787");
  CHECK(prov_server_url("ws://localhost:8787", u, sizeof u) == NULL);
  CHECK_STR(u, "ws://localhost:8787");
  // Refused, with a reason for the page; nothing is written.
  CHECK(prov_server_url("", u, sizeof u) != NULL);
  CHECK_STR(u, "");
  CHECK(prov_server_url("   /", u, sizeof u) != NULL);
  CHECK(prov_server_url("https://", u, sizeof u) != NULL);
  CHECK(prov_server_url("ftp://phone.example.com", u, sizeof u) != NULL);
  CHECK(prov_server_url("phone example.com", u, sizeof u) != NULL);
  CHECK_STR(u, "");
  CHECK(prov_server_url("phone.example.com/?x=\"<b>", u, sizeof u) != NULL);
  CHECK(prov_server_url("user@phone.example.com", u, sizeof u) != NULL);
  CHECK(prov_server_url("...", u, sizeof u) != NULL);
  char longest[200];
  memset(longest, 'a', sizeof longest - 1);
  longest[sizeof longest - 1] = '\0';
  CHECK(prov_server_url(longest, u, sizeof u) != NULL);
}

TEST(prov_server_choice_own_hub_or_keep) {
  char u[PROV_SERVER_MAX];
  // A fresh phone has no server: something must be chosen.
  CHECK(prov_server_choice("", "", "", u, sizeof u) != NULL);
  CHECK(prov_server_choice("own", "", "", u, sizeof u) != NULL);
  CHECK(prov_server_choice("own", "phone.example.com", "", u, sizeof u) == NULL);
  CHECK_STR(u, "wss://phone.example.com");
  // The hub is one choice, never a fallback.
  CHECK(prov_server_choice("hub", "phone.example.com", "", u, sizeof u) == NULL);
  CHECK_STR(u, PROV_HUB_URL);
  CHECK_STR(PROV_HUB_URL, "wss://hub.openloungephone.app");
  // Saving only Wi-Fi keeps the server.
  CHECK(prov_server_choice("", "", "wss://mine.example.org", u, sizeof u) == NULL);
  CHECK_STR(u, "wss://mine.example.org");
  CHECK(prov_server_choice("own", "bad address", "wss://mine.example.org", u, sizeof u) != NULL);
  // An address typed without picking "My own server" is that server, not "Choose a server".
  CHECK(prov_server_choice("", "phone.example.com", "", u, sizeof u) == NULL);
  CHECK_STR(u, "wss://phone.example.com");
  CHECK(strstr(or_none(prov_server_choice("", "  ", "", u, sizeof u)), "Choose a server") != NULL);
}

TEST(prov_server_form_preselects) {
  char html[1024];
  // Nothing saved: neither choice is made for the person.
  prov_server_form("", html, sizeof html);
  CHECK(strstr(html, "name=srv value=own>") != NULL);
  CHECK(strstr(html, "name=srv value=hub>") != NULL);
  CHECK(strstr(html, "checked>") == NULL);
  CHECK(strstr(html, "My own server") != NULL);
  CHECK(strstr(html, "Public hub") != NULL);
  CHECK(strstr(html, "free, to try it") != NULL);
  // No grey example in the box (it reads as filled in): the example is a hint under it.
  CHECK(strstr(html, "placeholder") == NULL);
  CHECK(strstr(html, "for example phone.example.com") != NULL);
  prov_server_form(PROV_HUB_URL, html, sizeof html);
  CHECK(strstr(html, "value=hub checked") != NULL);
  CHECK(strstr(html, "value=own checked") == NULL);
  CHECK(strstr(html, "value=\"\"") != NULL);
  prov_server_form("wss://mine.example.org/olp", html, sizeof html);
  CHECK(strstr(html, "value=own checked") != NULL);
  CHECK(strstr(html, "value=\"mine.example.org/olp\"") != NULL);
  // A local server keeps its ws:// so saving it again doesn't turn it into wss://.
  prov_server_form("ws://192.168.1.5:8787", html, sizeof html);
  CHECK(strstr(html, "value=\"ws://192.168.1.5:8787\"") != NULL);
  // Escaped, and never overflows.
  prov_server_form("wss://a\"b", html, sizeof html);
  CHECK(strstr(html, "a&quot;b") != NULL);
  char tiny[16];
  CHECK(prov_server_form("", tiny, sizeof tiny) == sizeof tiny - 1);
}

TEST(prov_server_host_for_display) {
  char h[64];
  prov_server_host("wss://phone.example.com:8443/olp", h, sizeof h);
  CHECK_STR(h, "phone.example.com:8443");
  prov_server_host("ws://192.168.1.5", h, sizeof h);
  CHECK_STR(h, "192.168.1.5");
}
