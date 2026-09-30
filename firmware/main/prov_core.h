// Wi-Fi setup network (SoftAP provisioning), the pure parts: when to open the setup network, the
// setup page's form and scan list, input checks, and the captive-portal DNS answer. No ESP-IDF
// here; unit-tested on the host (firmware/test/host). The ESP side is prov.c.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// --- when the setup network is open ---------------------------------------------------------

#define PROV_FALLBACK_MS (3 * 60 * 1000)  // saved Wi-Fi unreachable this long: open setup too

typedef enum {
  PROV_EV_BOOT,        // arg: has saved Wi-Fi; forced = MENU+BACK held at power-on
  PROV_EV_STA_UP,      // joined the saved Wi-Fi
  PROV_EV_STA_DOWN,    // lost it (or never got it)
  PROV_EV_TICK,        // time passes
  PROV_EV_SAVED,       // the page saved new credentials
  PROV_EV_OPEN,        // the console / menu asked for setup
} prov_event_t;

typedef enum { PROV_ACT_NONE, PROV_ACT_START_AP, PROV_ACT_STOP_AP, PROV_ACT_REBOOT } prov_action_t;

typedef struct {
  bool ap_on;          // the setup network is open
  bool has_creds;      // saved Wi-Fi exists
  bool sta_up;
  bool forced;         // asked for, or nothing saved: stays open until saved (STA_UP doesn't close it)
  int64_t down_since;  // when the station lost (or never had) Wi-Fi, -1 while up
} prov_t;

void prov_init(prov_t *p);
prov_action_t prov_step(prov_t *p, prov_event_t ev, bool has_creds, bool forced, int64_t now_ms);

// --- MENU+BACK held at power-on -------------------------------------------------------------

#define PROV_HOLD_SETUP_MS 3000   // held this long: open the setup network (keeps everything else)
#define PROV_HOLD_RESET_MS 10000  // this long: factory reset (Wi-Fi, owner, keys: docs/device-lifecycle.md)

typedef enum { PROV_HOLD_NONE, PROV_HOLD_SETUP, PROV_HOLD_RESET } prov_hold_t;
prov_hold_t prov_boot_hold(int held_ms);

// --- the setup page -------------------------------------------------------------------------

/** "OpenLoungePhone-XXXX": the last two MAC bytes in hex. */
void prov_ap_ssid(const uint8_t mac[6], char *out, size_t n);
/** 8 digits from 32 random bits (WPA2 needs at least 8 characters). */
void prov_ap_password(uint32_t random, char out[9]);

/**
 * Finds `key` in an application/x-www-form-urlencoded body and URL-decodes its value into `out`.
 * Returns the decoded length, or -1 if the key is missing or the value doesn't fit.
 */
int prov_form_get(const char *body, const char *key, char *out, size_t n);

/** NULL if a network can be saved with these, else why not (shown on the page). */
const char *prov_check(const char *ssid, const char *pass);

typedef struct {
  char ssid[33];
  int8_t rssi;
  bool secure;
} prov_ap_t;

/** Sorts strongest first, drops hidden and duplicate names (keeps the strongest). Returns count. */
int prov_scan_tidy(prov_ap_t *aps, int n);
/** Escapes text for HTML (& < > " '). Returns the length written (truncates safely). */
size_t prov_html_escape(const char *in, char *out, size_t n);

// --- the captive portal's DNS -----------------------------------------------------------------

/**
 * Answers a DNS query with one A record pointing at `ip` (network byte order), whatever the
 * name, so phones open the setup page. Returns the response length, or 0 to ignore the packet
 * (not a standard query, malformed, or not for an A/ANY record — those get an empty answer).
 */
size_t prov_dns_answer(const uint8_t *q, size_t qlen, uint8_t *out, size_t outlen, uint32_t ip);
