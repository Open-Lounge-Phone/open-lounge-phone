// netsel.c: which network a phone with a wired network uses (README "Wired network",
// docs/phone-ux.md "Network").
#include <string.h>

#include "check.h"
#include "netsel.h"

static netsel_t S;
static ns_input_t IN;
static int64_t T;

static void boot(bool wired, bool has_wifi) {
  T = 0;
  IN = (ns_input_t){.wired = wired, .has_wifi = has_wifi};
  netsel_init(&S, T);
  netsel_step(&S, NS_TICK, &IN, T);
}
static void ev(ns_event_t e) { netsel_step(&S, e, &IN, T); }
/** Time passes in 100 ms ticks, as the app task runs them. */
static void wait_ms(int64_t ms) {
  for (int64_t end = T + ms; T < end;) {
    T += 100;
    ev(NS_TICK);
  }
}
static const char *problem(const char *wifi) { return netsel_problem(&S, &IN, wifi); }
static const char *cable(void) {
  const char *t = netsel_cable_text(netsel_cable(&S, &IN));
  return t ? t : "-";
}
/** Settled on the cable at power-on. */
static void boot_on_cable(bool has_wifi) {
  boot(true, has_wifi);
  wait_ms(1500);
  ev(NS_LINK_UP);
  wait_ms(800);
  ev(NS_WIRED_IP);
}
/** Settled on Wi-Fi at power-on (no cable). */
static void boot_on_wifi(void) {
  boot(true, true);
  wait_ms(NETSEL_BOOT_LINK_MS);
  ev(NS_WIFI_IP);
}

TEST(netsel_without_a_wired_network_is_wifi_only) {
  boot(false, true);
  CHECK(S.settled);
  CHECK(S.wifi_on);
  CHECK(!S.phy_on);
  CHECK(S.uplink == NET_NONE);
  ev(NS_WIFI_IP);
  CHECK(S.uplink == NET_WIFI);
  ev(NS_WIFI_DOWN);
  CHECK(S.uplink == NET_NONE);
  // Wi-Fi's own words, unchanged.
  CHECK_STR(problem("WRONG PASSWORD?"), "WRONG PASSWORD?");
  CHECK(problem(NULL) == NULL);
  CHECK(netsel_cable(&S, &IN) == CABLE_ABSENT);
  CHECK(netsel_cable_text(CABLE_ABSENT) == NULL);
  // No cable looks: nothing to look with.
  wait_ms(2 * NETSEL_LOOK_EVERY_MS);
  CHECK(!S.phy_on);
}

TEST(netsel_power_on_waits_for_the_cable_with_wifi_off) {
  boot(true, true);
  CHECK(!S.settled);
  CHECK(S.phy_on);
  CHECK(!S.wifi_on);
  CHECK_STR(cable(), "CABLE CONNECTING");
  wait_ms(NETSEL_BOOT_LINK_MS - 200);
  CHECK(!S.settled);
  CHECK(!S.wifi_on);
}

TEST(netsel_cable_at_power_on_is_used_and_wifi_stays_off) {
  boot_on_cable(true);
  CHECK(S.settled);
  CHECK(S.uplink == NET_WIRED);
  CHECK(S.phy_on);
  CHECK(!S.wifi_on);
  CHECK_STR(cable(), "WIRED NETWORK");
  CHECK(problem("WEAK WI-FI") == NULL);
  // It stays that way: no looks, no Wi-Fi.
  wait_ms(3 * NETSEL_LOOK_EVERY_MS);
  CHECK(S.uplink == NET_WIRED);
  CHECK(!S.wifi_on);
  CHECK(S.phy_on);
}

TEST(netsel_a_link_waits_for_its_address_past_the_boot_window) {
  boot(true, true);
  wait_ms(NETSEL_BOOT_LINK_MS - 1000);
  ev(NS_LINK_UP);
  wait_ms(5000);  // past the boot window: the address is still on its way
  CHECK(!S.settled);
  CHECK(!S.wifi_on);
  ev(NS_WIRED_IP);
  CHECK(S.uplink == NET_WIRED);
}

TEST(netsel_no_cable_at_power_on_falls_back_to_wifi_and_powers_the_phy_down) {
  boot(true, true);
  wait_ms(NETSEL_BOOT_LINK_MS);
  CHECK(S.settled);
  CHECK(S.wifi_on);
  CHECK(!S.phy_on);
  CHECK(S.uplink == NET_NONE);
  CHECK(problem(NULL) == NULL);  // a Wi-Fi phone: no talk of cables while it joins
  CHECK_STR(problem("WRONG PASSWORD?"), "WRONG PASSWORD?");
  ev(NS_WIFI_IP);
  CHECK(S.uplink == NET_WIFI);
  CHECK_STR(cable(), "CABLE UNPLUGGED");
}

TEST(netsel_no_cable_and_no_wifi_keeps_the_phy_on) {
  boot(true, false);
  wait_ms(NETSEL_BOOT_LINK_MS);
  CHECK(S.settled);
  CHECK(!S.wifi_on);
  CHECK(S.phy_on);
  CHECK(S.uplink == NET_NONE);
  CHECK_STR(problem(NULL), "CABLE UNPLUGGED");
  wait_ms(3 * NETSEL_LOOK_EVERY_MS);
  CHECK(S.phy_on);  // never powered down: the cable is all it has
  ev(NS_LINK_UP);
  ev(NS_WIRED_IP);
  CHECK(S.uplink == NET_WIRED);
  CHECK(problem(NULL) == NULL);
}

TEST(netsel_a_link_without_an_address) {
  // With Wi-Fi: give the cable LEASE_MS, then Wi-Fi; look again only after a long while.
  boot(true, true);
  wait_ms(500);
  ev(NS_LINK_UP);
  wait_ms(NETSEL_LEASE_MS - 200);
  CHECK(!S.settled);
  wait_ms(300);
  CHECK(S.settled);
  CHECK(S.wifi_on);
  CHECK(!S.phy_on);
  CHECK_STR(cable(), "NO DHCP ON CABLE");
  ev(NS_LINK_DOWN);  // the PHY powered down
  CHECK_STR(cable(), "NO DHCP ON CABLE");
  wait_ms(2 * NETSEL_LOOK_EVERY_MS);
  CHECK(!S.phy_on);  // no quick looks after a cable without addresses
  wait_ms(NETSEL_NO_LEASE_EVERY_MS - 2 * NETSEL_LOOK_EVERY_MS);
  CHECK(S.phy_on);  // …but a look after the long wait

  // Without Wi-Fi: the PHY stays on and the screen says why.
  boot(true, false);
  ev(NS_LINK_UP);
  wait_ms(NETSEL_LEASE_MS + 200);
  CHECK(S.settled);
  CHECK(S.phy_on);
  CHECK(!S.wifi_on);
  CHECK_STR(problem(NULL), "NO DHCP ON CABLE");
  ev(NS_WIRED_IP);  // a DHCP server showed up after all
  CHECK(S.uplink == NET_WIRED);
}

TEST(netsel_on_wifi_it_looks_for_a_cable_now_and_then) {
  boot_on_wifi();
  int64_t settled_at = NETSEL_BOOT_LINK_MS;
  wait_ms(settled_at + NETSEL_LOOK_EVERY_MS - T - 200);
  CHECK(!S.phy_on);
  wait_ms(300);
  CHECK(S.phy_on);  // a look
  CHECK(S.wifi_on);
  CHECK(S.uplink == NET_WIFI);
  wait_ms(NETSEL_LOOK_MS);
  CHECK(!S.phy_on);  // nothing found: off again
  wait_ms(NETSEL_LOOK_EVERY_MS - NETSEL_LOOK_MS);
  CHECK(S.phy_on);  // the next look
  // This time a cable answers: link, address, and the phone moves to it.
  ev(NS_LINK_UP);
  wait_ms(NETSEL_LOOK_MS);  // past the look's end: the address is on its way, the PHY stays on
  CHECK(S.phy_on);
  CHECK(S.uplink == NET_WIFI);
  ev(NS_WIRED_IP);
  CHECK(S.uplink == NET_WIRED);
  CHECK(!S.wifi_on);
}

TEST(netsel_a_look_that_finds_no_address_waits_long_for_the_next) {
  boot_on_wifi();
  wait_ms(NETSEL_LOOK_EVERY_MS);  // a look
  CHECK(S.phy_on);
  ev(NS_LINK_UP);  // a cable with a link, but no DHCP server behind it
  wait_ms(NETSEL_LEASE_MS + 200);
  CHECK(!S.phy_on);  // given up on its address
  CHECK_STR(cable(), "NO DHCP ON CABLE");
  ev(NS_LINK_DOWN);  // the PHY is down
  wait_ms(3 * NETSEL_LOOK_EVERY_MS);
  CHECK(!S.phy_on);  // no 30 s looks at a cable that hands out no address
  wait_ms(NETSEL_NO_LEASE_EVERY_MS - 3 * NETSEL_LOOK_EVERY_MS);
  CHECK(S.phy_on);  // a look after the long wait
}

TEST(netsel_cable_unplugged_falls_back_to_wifi_and_comes_back) {
  boot_on_cable(true);
  ev(NS_LINK_DOWN);
  CHECK(S.uplink == NET_NONE);
  CHECK(S.wifi_on);  // Wi-Fi at once
  CHECK(S.phy_on);   // and the PHY on a moment longer (a cable bumped out and back in)
  CHECK_STR(problem(NULL), "CABLE UNPLUGGED");
  CHECK_STR(problem("WEAK WI-FI"), "WEAK WI-FI");  // what it's trying now says more
  // Plugged straight back in: on the cable again.
  wait_ms(2000);
  ev(NS_LINK_UP);
  ev(NS_WIRED_IP);
  CHECK(S.uplink == NET_WIRED);
  CHECK(!S.wifi_on);
  // Out for good: Wi-Fi joins, the PHY powers down after the look.
  ev(NS_LINK_DOWN);
  wait_ms(1000);
  ev(NS_WIFI_IP);
  CHECK(S.uplink == NET_WIFI);
  CHECK(problem(NULL) == NULL);
  wait_ms(NETSEL_LOOK_MS);
  CHECK(!S.phy_on);
  CHECK_STR(cable(), "CABLE UNPLUGGED");
  // Wi-Fi drops later: a Wi-Fi phone now, so no talk of the cable.
  ev(NS_WIFI_DOWN);
  CHECK(problem(NULL) == NULL);
}

TEST(netsel_cable_unplugged_without_wifi_waits_for_it) {
  boot_on_cable(false);
  ev(NS_LINK_DOWN);
  CHECK(S.uplink == NET_NONE);
  CHECK(!S.wifi_on);
  wait_ms(3 * NETSEL_LOOK_EVERY_MS);
  CHECK(S.phy_on);
  CHECK_STR(problem(NULL), "CABLE UNPLUGGED");
  ev(NS_LINK_UP);
  CHECK_STR(cable(), "CABLE CONNECTING");
  CHECK(problem(NULL) == NULL);
  ev(NS_WIRED_IP);
  CHECK(S.uplink == NET_WIRED);
}

TEST(netsel_address_lost_with_the_link_up) {
  boot_on_cable(true);
  ev(NS_WIRED_IP_LOST);
  CHECK(S.uplink == NET_NONE);
  CHECK(S.wifi_on);
  wait_ms(NETSEL_LOOK_MS + 2000);
  CHECK(S.phy_on);  // the link is up and the address may be renewed: keep it on
  ev(NS_WIRED_IP);
  CHECK(S.uplink == NET_WIRED);
  CHECK(!S.wifi_on);
}

TEST(netsel_a_call_on_wifi_finishes_there) {
  boot_on_wifi();
  wait_ms(NETSEL_LOOK_EVERY_MS);  // a look starts
  CHECK(S.phy_on);
  IN.busy = true;  // a call starts during the look
  ev(NS_LINK_UP);
  ev(NS_WIRED_IP);
  CHECK(S.uplink == NET_WIFI);  // not moved mid-call
  CHECK(S.wifi_on);
  CHECK(S.phy_on);  // the cable stays ready
  CHECK_STR(cable(), "CABLE AFTER CALL");
  wait_ms(60000);
  CHECK(S.uplink == NET_WIFI);
  IN.busy = false;  // hung up
  ev(NS_TICK);
  CHECK(S.uplink == NET_WIRED);
  CHECK(!S.wifi_on);
}

TEST(netsel_a_call_on_wifi_moves_if_wifi_drops) {
  boot_on_wifi();
  wait_ms(NETSEL_LOOK_EVERY_MS);
  IN.busy = true;
  ev(NS_LINK_UP);
  ev(NS_WIRED_IP);
  ev(NS_WIFI_DOWN);  // the call's network is gone anyway: use the cable now
  CHECK(S.uplink == NET_WIRED);
}

TEST(netsel_no_looks_during_a_call) {
  boot_on_wifi();
  IN.busy = true;
  wait_ms(3 * NETSEL_LOOK_EVERY_MS);
  CHECK(!S.phy_on);
  IN.busy = false;
  ev(NS_TICK);
  CHECK(S.phy_on);  // overdue: looks as soon as the call ends
}

TEST(netsel_losing_the_cable_mid_call_switches_at_once) {
  boot_on_cable(true);
  IN.busy = true;
  ev(NS_LINK_DOWN);
  CHECK(S.uplink == NET_NONE);
  CHECK(S.wifi_on);
  ev(NS_WIFI_IP);
  CHECK(S.uplink == NET_WIFI);
}

TEST(netsel_wifi_saved_later_is_used_when_the_cable_is_out) {
  boot(true, false);
  wait_ms(NETSEL_BOOT_LINK_MS);
  CHECK(!S.wifi_on);
  IN.has_wifi = true;  // `wifi <ssid>` on the console
  ev(NS_TICK);
  CHECK(S.wifi_on);
  CHECK(!S.phy_on);
}

TEST(netsel_texts_fit_the_screen) {
  for (int c = CABLE_ABSENT; c <= CABLE_NO_ADDRESS; c++) {
    const char *t = netsel_cable_text((cable_state_t)c);
    if (t) CHECK(strlen(t) <= 16);
  }
}
