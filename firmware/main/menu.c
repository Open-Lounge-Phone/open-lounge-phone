#include "menu.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

#include "app.h"
#include "audio.h"
#include "identity.h"
#include "net.h"

/** Digit key index (protocol order: 1-9 → 0-8, 0 → 9) to the digit it shows. */
static int digit_of(int key) { return key == 9 ? 0 : key + 1; }

const char *menu_screen_name(menu_screen_t s) {
  static const char *names[] = {"closed", "root", "about", "wifi", "volume"};
  return names[s];
}

void menu_close(menu_t *m) { m->screen = MENU_CLOSED; }

bool menu_key(menu_t *m, int key, int64_t now_ms) {
  if (m->screen == MENU_CLOSED) {
    if (key != 10) return false;
    m->screen = MENU_ROOT;
    m->last_input_ms = now_ms;
    return true;
  }
  m->last_input_ms = now_ms;
  if (key == 10) {  // MENU closes it from anywhere
    m->screen = MENU_CLOSED;
  } else if (key == 11) {  // BACK steps out
    m->screen = m->screen == MENU_ROOT ? MENU_CLOSED : MENU_ROOT;
  } else if (m->screen == MENU_ROOT) {
    int d = digit_of(key);
    if (d == 0) m->screen = MENU_ABOUT;
    else if (d == 9) {
      app_post(EV_OTA_NOW, 0, NULL);  // 9 = update now
      m->screen = MENU_CLOSED;
    } else if (d == 1) m->screen = MENU_VOLUME;
    else if (d == 3) m->screen = MENU_WIFI;
  } else if (m->screen == MENU_WIFI) {
    if (digit_of(key) == 1) {
      app_post(EV_PROV_OPEN, 0, NULL);  // 1 = set up Wi-Fi (the setup network)
      m->screen = MENU_CLOSED;
    }
  } else if (m->screen == MENU_VOLUME) {
    int d = digit_of(key);
    if (d == 1) audio_set_volume(audio_volume() - 1);
    else if (d == 2) audio_set_volume(audio_volume() + 1);
  }
  return true;
}

void menu_tick(menu_t *m, int64_t now_ms) {
  if (m->screen != MENU_CLOSED && now_ms - m->last_input_ms >= MENU_TIMEOUT_MS)
    m->screen = MENU_CLOSED;
}

static void upper(char *s) {
  for (; *s; s++) *s = (char)toupper((unsigned char)*s);
}

int menu_lines(const menu_t *m, char out[4][25]) {
  switch (m->screen) {
    case MENU_ROOT:
      snprintf(out[0], 25, "MENU");
      snprintf(out[1], 25, "1 VOLUME 3 WI-FI");
      snprintf(out[2], 25, "9 UPDATE 0 ABOUT");
      return 3;
    case MENU_VOLUME:
      snprintf(out[0], 25, "VOLUME %d/%d", audio_volume(), VOLUME_MAX);
      snprintf(out[1], 25, "1 LOWER 2 LOUDER");
      return 2;
    case MENU_ABOUT: {
      const char *const *w = identity_fingerprint();
      snprintf(out[0], 25, "FW %.21s", FW_VERSION);
      snprintf(out[1], 25, "%s %s", w[0], w[1]);
      snprintf(out[2], 25, "%s %s", w[2], w[3]);
      upper(out[1]);
      upper(out[2]);
      return 3;
    }
    case MENU_WIFI: {
      char ssid[33] = "", ip[16] = "";
      int rssi = 0;
      net_wifi_info(ssid, sizeof ssid, &rssi, ip, sizeof ip);
      if (!net_wifi_up()) {
        snprintf(out[0], 25, "WI-FI OFFLINE");
        snprintf(out[1], 25, "%.24s", ssid[0] ? ssid : "NOT SET");
        upper(out[1]);
        snprintf(out[2], 25, "1 SET UP WI-FI");
        return 3;
      }
      snprintf(out[0], 25, "%.24s", ssid);
      upper(out[0]);
      snprintf(out[1], 25, "SIGNAL %d DBM", rssi);
      snprintf(out[2], 25, "%s", ip);
      snprintf(out[3], 25, "1 SET UP WI-FI");
      return 4;
    }
    default:
      return 0;
  }
}
