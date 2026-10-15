// Which network the phone uses on a board with a wired network (hw v0.901: the RJ45 and Wi-Fi),
// the pure part: no ESP-IDF here, unit-tested on the host (firmware/test/host/test_netsel.c).
// The ESP side (net.c, eth.c) feeds it events and makes its outputs true. README "Wired network".
//
// - A cable with a link and an address (DHCP) is used: it carries the server connection and the
//   calls, and the Wi-Fi radio is off.
// - No cable, a link with no address, or the cable lost: Wi-Fi, if one is saved. The cable's PHY
//   is powered down meanwhile and woken now and then to look for a cable.
// - No Wi-Fi saved: the PHY stays on and the phone waits for the cable.
// - A call on Wi-Fi stays there until it ends (moving it would drop it); losing the network in
//   use switches at once (the call is gone with it).
#pragma once
#include <stdbool.h>
#include <stdint.h>

#define NETSEL_BOOT_LINK_MS 5000            // power-on: wait this long for a cable's link
#define NETSEL_LEASE_MS 15000               // a link without an address this long: not usable
#define NETSEL_LOOK_EVERY_MS 30000          // on Wi-Fi: look for a cable this often
#define NETSEL_LOOK_MS 6000                 // a look: the PHY on this long (autonegotiation)
#define NETSEL_NO_LEASE_EVERY_MS 300000     // after a link that got no address: look this often

typedef enum { NET_NONE, NET_WIRED, NET_WIFI } net_uplink_t;

typedef enum {
  NS_TICK,
  NS_LINK_UP,        // the cable's link came up (autonegotiated)
  NS_LINK_DOWN,      // …went down (unplugged, or the PHY powered down)
  NS_WIRED_IP,       // an address on the cable (DHCP)
  NS_WIRED_IP_LOST,  // …lost with the link still up
  NS_WIFI_IP,        // Wi-Fi joined, with an address
  NS_WIFI_DOWN,      // Wi-Fi lost (or never joined)
} ns_event_t;

typedef struct {
  bool wired;     // the board has a wired network and its controller answered
  bool has_wifi;  // a Wi-Fi network is saved
  bool busy;      // a call is on (don't move it to the cable, don't look for one)
} ns_input_t;

typedef struct {
  // What the ESP side makes true.
  bool phy_on;          // the cable's PHY powered (autonegotiating)
  bool wifi_on;         // the Wi-Fi station joins the saved network
  net_uplink_t uplink;  // the network in use
  bool settled;         // the power-on choice is made (the setup network may decide now)
  // What it knows.
  bool link, wired_ip, wifi_ip;
  bool no_lease;   // the last link got no address in time
  bool was_wired;  // the cable was the last network in use
  int64_t boot_until, lease_until, look_at, look_until;  // -1 = not running
} netsel_t;

void netsel_init(netsel_t *s, int64_t now_ms);
void netsel_step(netsel_t *s, ns_event_t ev, const ns_input_t *in, int64_t now_ms);

/** The cable as the phone sees it (MENU 3's first line). */
typedef enum {
  CABLE_ABSENT,      // no wired network on this board (or its controller didn't answer)
  CABLE_STARTING,    // power-on, or a link waiting for its address
  CABLE_IN_USE,
  CABLE_AFTER_CALL,  // it works; the phone moves to it when the call ends
  CABLE_UNPLUGGED,   // no link (now, or at the last look while on Wi-Fi)
  CABLE_NO_ADDRESS,  // a link, but no address from DHCP
} cable_state_t;

cable_state_t netsel_cable(const netsel_t *s, const ns_input_t *in);
/** The cable's state in words (≤ 16 characters), NULL for CABLE_ABSENT. */
const char *netsel_cable_text(cable_state_t c);
/**
 * Why the phone is offline, for the status screen's second line (≤ 16 characters), or NULL.
 * `wifi_problem` is Wi-Fi's own reason (net_wifi_problem). Without a wired network this is
 * exactly `wifi_problem`.
 */
const char *netsel_problem(const netsel_t *s, const ns_input_t *in, const char *wifi_problem);
