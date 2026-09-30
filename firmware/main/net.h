#pragma once
#include <stdbool.h>
#include <stddef.h>

void net_start(void);
/** Store Wi-Fi credentials in NVS and reconnect. */
void net_set_wifi(const char *ssid, const char *pass);
/** The server base URL (NVS, else Kconfig), e.g. wss://l1.openloungephone.app */
void net_server_url(char *out, size_t len);
void net_set_server(const char *url);
/** Open (or reopen) the WebSocket to `url` (full URL incl. path). */
void net_ws_open(const char *url);
void net_ws_close(void);
bool net_ws_send(const char *text);
bool net_wifi_up(void);
/** Wi-Fi status for MENU and the console: SSID, RSSI (dBm) and IP. */
void net_wifi_info(char *ssid, size_t ssid_len, int *rssi, char *ip, size_t ip_len);
