#include "netsel.h"

#include <stddef.h>

void netsel_init(netsel_t *s, int64_t now) {
  *s = (netsel_t){
      .phy_on = true,  // power-on: look for a cable before turning Wi-Fi on
      .boot_until = now + NETSEL_BOOT_LINK_MS,
      .lease_until = -1,
      .look_at = -1,
      .look_until = -1,
  };
}

static void facts(netsel_t *s, ns_event_t ev, int64_t now) {
  switch (ev) {
    case NS_LINK_UP:
      if (!s->link) {
        s->link = true;
        s->no_lease = false;
        s->lease_until = now + NETSEL_LEASE_MS;
      }
      break;
    case NS_LINK_DOWN:
      s->link = s->wired_ip = false;
      s->lease_until = -1;
      break;
    case NS_WIRED_IP:
      s->link = s->wired_ip = true;
      s->no_lease = false;
      s->lease_until = -1;
      break;
    case NS_WIRED_IP_LOST:
      if (s->wired_ip) {
        s->wired_ip = false;
        if (s->link) s->lease_until = now + NETSEL_LEASE_MS;  // it may come back (renewal)
      }
      break;
    case NS_WIFI_IP:
      s->wifi_ip = true;
      break;
    case NS_WIFI_DOWN:
      s->wifi_ip = false;
      break;
    case NS_TICK:
      break;
  }
  if (s->link && !s->wired_ip && s->lease_until >= 0 && now >= s->lease_until) {
    s->no_lease = true;  // a link, but nobody hands out an address
    s->lease_until = -1;
  }
}

void netsel_step(netsel_t *s, ns_event_t ev, const ns_input_t *in, int64_t now) {
  facts(s, ev, now);
  if (!in->wired) {  // Wi-Fi only (rev A, or the wired controller didn't answer)
    s->phy_on = false;
    s->wifi_on = true;
    s->settled = true;
    s->uplink = s->wifi_ip ? NET_WIFI : NET_NONE;
    return;
  }
  bool cable = s->link && s->wired_ip;
  if (!s->settled) {
    // Power-on: the cable first, Wi-Fi off, until it works or clearly won't.
    s->phy_on = true;
    s->wifi_on = false;
    s->uplink = NET_NONE;
    if (!cable && !s->no_lease && (s->link || now < s->boot_until)) return;
    s->settled = true;
    if (!cable) s->look_at = now + (s->no_lease ? NETSEL_NO_LEASE_EVERY_MS : NETSEL_LOOK_EVERY_MS);
  }
  if (cable) {
    if (s->uplink == NET_WIFI && s->wifi_ip && in->busy) {
      // A call on Wi-Fi finishes there; the cable stays up and takes over when it ends.
      s->phy_on = s->wifi_on = true;
      return;
    }
    s->uplink = NET_WIRED;
    s->phy_on = true;
    s->wifi_on = false;
    s->was_wired = true;
    s->look_at = s->look_until = -1;
    return;
  }
  // The cable doesn't work (now).
  if (s->uplink == NET_WIRED) {
    // Just lost: keep looking a moment (a cable bumped out and back in) while Wi-Fi starts.
    s->look_until = now + NETSEL_LOOK_MS;
    s->look_at = now + NETSEL_LOOK_EVERY_MS;
  }
  if (!in->has_wifi) {  // nothing else to use: keep the PHY on and wait for the cable
    s->uplink = NET_NONE;
    s->wifi_on = false;
    s->phy_on = true;
    s->look_at = s->look_until = -1;
    return;
  }
  s->wifi_on = true;
  s->uplink = s->wifi_ip ? NET_WIFI : NET_NONE;
  if (s->uplink == NET_WIFI) s->was_wired = false;
  // The PHY is off on Wi-Fi, except for a look now and then (every LOOK_EVERY, start to start).
  if (s->look_until >= 0) {
    bool address_coming = s->link && !s->wired_ip && !s->no_lease;
    if (now < s->look_until || address_coming) {
      s->phy_on = true;
      return;
    }
    s->look_until = -1;  // nothing usable: off until the next look
    if (s->no_lease) s->look_at = now + NETSEL_NO_LEASE_EVERY_MS;
  }
  if (s->look_at < 0) s->look_at = now + NETSEL_LOOK_EVERY_MS;
  if (now >= s->look_at && !in->busy) {
    s->look_until = now + NETSEL_LOOK_MS;
    s->look_at = now + NETSEL_LOOK_EVERY_MS;
    s->phy_on = true;
    return;
  }
  s->phy_on = false;
}

cable_state_t netsel_cable(const netsel_t *s, const ns_input_t *in) {
  if (!in->wired) return CABLE_ABSENT;
  if (s->uplink == NET_WIRED) return CABLE_IN_USE;
  if (s->link && s->wired_ip) return CABLE_AFTER_CALL;
  if (s->no_lease) return CABLE_NO_ADDRESS;
  if (!s->settled || s->link) return CABLE_STARTING;
  return CABLE_UNPLUGGED;
}

const char *netsel_cable_text(cable_state_t c) {
  switch (c) {
    case CABLE_STARTING: return "CABLE CONNECTING";
    case CABLE_IN_USE: return "WIRED NETWORK";
    case CABLE_AFTER_CALL: return "CABLE AFTER CALL";
    case CABLE_UNPLUGGED: return "CABLE UNPLUGGED";
    case CABLE_NO_ADDRESS: return "NO DHCP ON CABLE";
    case CABLE_ABSENT: break;
  }
  return NULL;
}

const char *netsel_problem(const netsel_t *s, const ns_input_t *in, const char *wifi_problem) {
  if (s->uplink != NET_NONE) return NULL;
  if (!in->wired) return wifi_problem;
  cable_state_t c = netsel_cable(s, in);
  bool cable_says = c == CABLE_UNPLUGGED || c == CABLE_NO_ADDRESS;
  if (in->has_wifi) {
    // Wi-Fi is what it's trying: its reason first; the cable's only if the cable was in use.
    if (wifi_problem) return wifi_problem;
    return s->was_wired && cable_says ? netsel_cable_text(c) : NULL;
  }
  return cable_says ? netsel_cable_text(c) : NULL;
}
