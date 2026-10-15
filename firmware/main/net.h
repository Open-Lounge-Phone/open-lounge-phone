#pragma once
#include <stdbool.h>
#include <stddef.h>

#include "netsel.h"

void net_start(void);
/** Store Wi-Fi credentials in NVS and reconnect. */
void net_set_wifi(const char *ssid, const char *pass);
/** Store Wi-Fi credentials without reconnecting (the setup page: the phone restarts). "" = none. */
void net_save_wifi(const char *ssid, const char *pass);
/** Saved Wi-Fi exists (NVS, else the Kconfig default). */
bool net_has_wifi(void);
/** While the setup network is up, retry the saved Wi-Fi only once a minute. */
void net_slow_retry(bool slow);
/** The server base URL (NVS, else Kconfig; "" = none chosen yet), e.g. wss://phone.example.com */
void net_server_url(char *out, size_t len);
void net_set_server(const char *url);
/** Open (or reopen) the WebSocket to `url` (full URL incl. path). */
void net_ws_open(const char *url);
void net_ws_close(void);
/** Stops the client for good (no automatic reconnects) until `net_ws_open`. */
void net_ws_stop(void);
bool net_ws_send(const char *text);
bool net_wifi_up(void);
/** Why the last Wi-Fi join failed, in words for the screen (≤ 16 chars), or NULL. */
const char *net_wifi_problem(void);
/** The last Wi-Fi failure since power-on, even after a later join (NULL = none). */
const char *net_last_wifi_problem(int *reason);
/** The joined network's channel (0 = not joined). */
int net_wifi_channel(void);
/** Wi-Fi status for MENU and the console: SSID, RSSI (dBm) and IP. */
void net_wifi_info(char *ssid, size_t ssid_len, int *rssi, char *ip, size_t ip_len);

// --- the network in use: the cable (hw v0.901) or Wi-Fi -----------------------------------------

typedef enum {
  NET_SAME,       // nothing the app needs to know
  NET_WENT_UP,    // online (the same kind of network as before, or the first one)
  NET_WENT_DOWN,  // no network
  NET_SWITCHED,   // online over the other network (cable <-> Wi-Fi): reconnect the server
} net_change_t;

/**
 * hw v0.901: runs the network choice (netsel.c) for an EV_NET event (`ev` = ns_event_t) or a
 * tick (NS_TICK) and applies it (the cable's PHY, the Wi-Fi radio, the default route). `busy`: a
 * call is on. Rev A: always NET_SAME (Wi-Fi posts EV_WIFI_UP / EV_WIFI_DOWN as it always did).
 */
net_change_t net_select(int ev, bool busy);
/** The power-on network choice is made (rev A: at once): setup may decide whether to open. */
bool net_settled(void);
/** The board has a wired network and its controller answered. */
bool net_wired(void);
/** The phone has a network (the cable or Wi-Fi). */
bool net_up(void);
net_uplink_t net_uplink(void);
/** The address on the network in use ("" = none). */
void net_uplink_ip(char *ip, size_t n);
/** Why the phone has no network, for the status screen (≤ 16 characters), or NULL. */
const char *net_problem(void);
/** MENU 3's first line on a board with a wired network ("WIRED NETWORK", "CABLE UNPLUGGED"…),
 * NULL on rev A. */
const char *net_cable_line(void);
/** The setup network opens (true) or closes: hw v0.901 turns the radio on for it. */
void net_setup_radio(bool on);
