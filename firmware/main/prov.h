// The Wi-Fi setup network: "OpenLoungePhone-XXXX" (WPA2, an 8-digit password shown on the
// display), a captive-portal DNS and a one-page setup site at http://192.168.4.1/ (scan list +
// password → save → restart). The decisions are prov_core.c; this is the ESP side.
#pragma once
#include <stdbool.h>

/** Opens the setup network (AP + STA: the phone keeps trying its saved Wi-Fi meanwhile). */
void prov_start_ap(void);
void prov_stop_ap(void);
bool prov_ap_active(void);
const char *prov_ssid(void);
const char *prov_password(void);
/**
 * Bring-up/simulator check of the setup site from the phone itself (HTTP to 127.0.0.1): fetches
 * the page, then (if `save_ssid`) posts it like a person would. Prints `PROV TEST …` lines.
 */
void prov_selftest(const char *save_ssid, const char *save_pass);
