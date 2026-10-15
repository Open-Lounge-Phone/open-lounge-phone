// The wired network on hw v0.901: a WIZnet W5500 (10/100 MAC + PHY) on the display's SPI bus,
// polled (its INTn has no GPIO), with ESP-IDF's esp_eth driver and esp_netif (DHCP). In a QEMU
// build for that board, QEMU's OpenCores Ethernet stands in for it. Rev A builds have none of
// this: every function below is a stub that says so. Which network is used is netsel.c's choice;
// net.c applies it. README "Wired network".
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "board.h"

typedef struct {
  bool present;   // the controller answered at power-on
  bool phy_on;    // its PHY is powered (autonegotiating or linked)
  bool link;
  int speed_mbps; // 10 or 100 (0 = no link)
  bool full_duplex;
  bool has_ip;
  char ip[16];
  uint8_t mac[6];
} eth_info_t;

#if BOARD_HAS_ETHERNET
/** Installs the driver and its network interface; true if the controller answered. Events go to
 * the app as EV_NET (netsel's NS_LINK_*, NS_WIRED_IP*). The PHY starts powered. */
bool eth_start(void);
/** Wakes the PHY (autonegotiation) or powers it down (W5500 PHYCFGR; the link reads down). The
 * driver keeps running: one SPI read of the link every 500 ms, no RX polling without a link. */
void eth_phy(bool on);
bool eth_present(void);
void eth_info(eth_info_t *out);
/** The interface (for the default route), NULL if not present. */
void *eth_netif(void);
#else
static inline bool eth_start(void) { return false; }
static inline void eth_phy(bool on) { (void)on; }
static inline bool eth_present(void) { return false; }
static inline void eth_info(eth_info_t *out) { *out = (eth_info_t){0}; }
static inline void *eth_netif(void) { return 0; }
#endif
