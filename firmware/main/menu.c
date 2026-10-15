#include "menu.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

#include "app.h"
#include "audio.h"
#include "display.h"
#include "identity.h"
#include "net.h"
#include "ota.h"
#include "prov_core.h"
#include "signals.h"
#if CONFIG_OLP_LABS
#include "labs.h"
#endif

/** Digit key index (protocol order: 1-9 → 0-8, 0 → 9) to the digit it shows. */
static int digit_of(int key) { return key == 9 ? 0 : key + 1; }

const char *menu_screen_name(menu_screen_t s) {
  static const char *names[] = {"closed",    "root", "about", "wifi", "volume", "server",
                                "voicemail", "call", "check", "ext",  "labs",  "missed"};
  return names[s];
}

void menu_close(menu_t *m) { m->screen = MENU_CLOSED; }

/** The call screen's action on digit `d`, or -1. */
static int call_action_on(const menu_t *m, int d) {
  for (int i = 0; i < m->n_actions; i++)
    if (phone_action_digit(m->actions[i]) == d) return (int)m->actions[i];
  return -1;
}

/** The call screen offers a blind transfer (in a call, nothing on hold). */
static bool call_can_transfer(const menu_t *m) {
  for (int i = 0; i < m->n_actions; i++)
    if (m->actions[i] == ACT_TRANSFER && m->actions[0] == ACT_HOLD) return true;
  return false;
}

bool menu_key(menu_t *m, int key, int64_t now_ms) {
  if (m->screen == MENU_CLOSED) {
    if (key != 10) return false;
    m->screen = m->n_actions ? MENU_CALL : MENU_ROOT;  // in a call: what can be done there
    m->last_input_ms = now_ms;
    return true;
  }
  m->last_input_ms = now_ms;
  if (m->screen == MENU_EXT) {  // MENU 6: digits, BACK deletes, MENU dials
    size_t len = strlen(m->ext);
    if (key == 10) {
      if (len >= 2) app_post(EV_EXT_DIAL, m->ext_transfer, strdup(m->ext));
      m->screen = MENU_CLOSED;
    } else if (key == 11) {
      if (len) m->ext[len - 1] = '\0';
      else m->screen = MENU_ROOT;
    } else if (len + 1 < sizeof m->ext && len < 6) {
      m->ext[len] = (char)('0' + digit_of(key));
      m->ext[len + 1] = '\0';
    }
    return true;
  }
  if (key == 10) {  // MENU closes it from anywhere
    m->screen = MENU_CLOSED;
  } else if (key == 11) {  // BACK steps out
    m->screen = m->screen == MENU_ROOT || m->screen == MENU_CALL ? MENU_CLOSED
                : m->screen == MENU_VOLUME && m->n_actions ? MENU_CALL
                                                            : MENU_ROOT;
  } else if (m->screen == MENU_ROOT) {
    int d = digit_of(key);
    if (d == 0) m->screen = MENU_ABOUT;
    else if (d == 9) {
      app_post(EV_OTA_NOW, 0, NULL);  // 9 = update now
      m->screen = MENU_CLOSED;
    } else if (d == 1) m->screen = MENU_VOLUME;
    else if (d == 2) m->screen = MENU_VOICEMAIL;
#if CONFIG_OLP_LABS
    else if (d == 4 && !m->lounge) m->screen = MENU_LABS;  // labs: the settings page and PIN
#endif
    else if (d == 3 || d == 4) {  // Wi-Fi and server share one screen (and one setup page)
      m->screen = MENU_WIFI;
      m->confirm = false;
    } else if (d == 7) m->screen = MENU_CHECK;
    else if (d == 6 && m->extensions) {
      m->screen = MENU_EXT;
      m->ext[0] = '\0';
    } else if (d == 5 && m->lounge_session) {
      app_post(EV_LOUNGE_CHAT, !m->open_to_chat, NULL);
      m->screen = MENU_CLOSED;
    } else if (d == 5 && m->calls) {
      m->screen = MENU_MISSED;  // missed calls, one at a time
      m->missed_index = 0;
    } else if (d == 8 && m->lounge_session) {
      app_post(EV_LOUNGE_LEAVE, 0, NULL);
      m->screen = MENU_CLOSED;
    } else if (d == 8 && m->calls) {
      app_post(EV_REDIAL, 0, NULL);  // call again what this phone last called
      m->screen = MENU_CLOSED;
    }
  } else if (m->screen == MENU_CALL) {
    int d = digit_of(key);
    int action = call_action_on(m, d);
    if (action >= 0) {
      app_post(EV_CALL_ACTION, action, NULL);
      m->screen = MENU_CLOSED;
    } else if (d == 9) {
      m->screen = MENU_VOLUME;
    } else if (d == 6 && m->extensions && call_can_transfer(m)) {
      m->screen = MENU_EXT;  // transfer to an extension
      m->ext[0] = '\0';
      m->ext_transfer = true;
    }
  } else if (m->screen == MENU_MISSED) {
    int d = digit_of(key);
    int i = m->missed_n ? m->missed_index % m->missed_n : 0;
    if (d == 1 && m->missed_n && m->missed_id[i][0]) {
      app_post(EV_CALL_BACK, 0, strdup(m->missed_id[i]));
      m->screen = MENU_CLOSED;
    } else if (d == 2 && m->missed_n > 1) {
      m->missed_index = (i + 1) % m->missed_n;
    } else if (d == 3 && m->missed_n) {
      app_post(EV_MISSED_CLEAR, 0, NULL);  // the list empties when the server says so
      m->missed_index = 0;
    }
  } else if (m->screen == MENU_VOICEMAIL && m->can_play) {
    int d = digit_of(key);
    if (d == 1 || (d == 3 && m->voicemail > 0)) {
      app_post(EV_VM_PLAY, d == 3, NULL);
      m->screen = MENU_CLOSED;
    }
  } else if (m->screen == MENU_CHECK) {
    if (digit_of(key) == 1) {
      app_post(EV_SELFTEST, 0, NULL);
      m->screen = MENU_CLOSED;
    }
  } else if (m->screen == MENU_WIFI || m->screen == MENU_SERVER) {
    if (digit_of(key) == 1 && m->setup != SETUP_HIDDEN) {
      if (m->setup == SETUP_CONFIRM && !m->confirm) {
        m->confirm = true;  // a kids' phone: press 1 again
      } else {
        app_post(EV_PROV_OPEN, 0, NULL);  // the setup page (Wi-Fi and server)
        m->screen = MENU_CLOSED;
      }
    }
  } else if (m->screen == MENU_VOLUME) {
    int d = digit_of(key);
    if (d == 1) audio_set_volume(audio_volume() - 1);
    else if (d == 2) audio_set_volume(audio_volume() + 1);
    else if (d == 4) {  // ringer loudness: soft, medium, loud, round again; plays it
      signals_set_ring_level(signals_ring_level() % RING_LEVELS + 1);
      signals_ring_preview();
    } else if (d == 5) {  // ring style
      signals_set_ring_style((ring_style_t)((signals_ring_style() + 1) % RING_STYLES));
      signals_ring_preview();
    }
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

int menu_lines(const menu_t *m, char out[MENU_LINES][25]) {
  switch (m->screen) {
    case MENU_ROOT: {
      // The items that apply, packed into three lines that fit the screen (20 characters on
      // the 2.13-inch, 24 on the 2.9-inch). Every key works even where it isn't shown.
      int w, h;
      display_size(&w, &h);
      int cap = (w - 8) / 12 > 24 ? 24 : (w - 8) / 12;
      const char *items[12];
      int n = 0;
      items[n++] = "1 VOLUME";
      if (m->lounge_session) {
        items[n++] = m->open_to_chat ? "5 CHAT OFF" : "5 CHAT";
        items[n++] = "8 LOG OUT";
      } else if (!m->lounge) {
        items[n++] = "2 VOICEMAIL";
      }
      items[n++] = "3 NETWORK";
#if CONFIG_OLP_LABS
      if (!m->lounge) items[n++] = "4 LABS";
#endif
      if (m->calls && !m->lounge_session) items[n++] = "5 MISSED";
      if (m->extensions) items[n++] = "6 EXT";
      items[n++] = "7 CHECK";
      if (m->calls && !m->lounge_session) items[n++] = "8 REDIAL";
      items[n++] = "0 ABOUT";
      if (ota_enabled()) items[n++] = "9 UPDATE";  // last: the one left off when it won't fit
      snprintf(out[0], 25, "MENU");
      int line = 1;
      for (int i = 1; i < MENU_LINES; i++) out[i][0] = '\0';
      for (int i = 0; i < n && line < MENU_LINES; i++) {
        size_t have = strlen(out[line]), add = strlen(items[i]);
        if (have && have + 1 + add > (size_t)cap) {
          if (++line >= MENU_LINES) break;
          have = 0;
        }
        snprintf(out[line] + have, 25 - have, "%s%s", have ? " " : "", items[i]);
      }
      return line < MENU_LINES ? line + 1 : MENU_LINES;
    }
    case MENU_CALL: {
      // One call has audio at a time on this phone, so "hold" doesn't add a caller here (the
      // browser phone and the app can: merge and attended transfer follow from that).
      // Each action on its digit (1 hold / resume, 2 transfer, 3 mute), 9 the volume.
      static const char *labels[] = {"HOLD", "RESUME", "MERGE", "TRANSFER", "MUTE", "UNMUTE"};
      bool room = m->n_actions == 1 && (m->actions[0] == ACT_MUTE || m->actions[0] == ACT_UNMUTE);
      snprintf(out[0], 25, "%s", room && !m->in_call ? "ROOM" : "CALL");
      int n = 1;
      for (int d = 1; d <= 3; d++) {
        int a = call_action_on(m, d);
        if (a < 0) continue;
        if (d == 3) {  // mute shares its line with the volume
          snprintf(out[n++], 25, "3 %s 9 VOLUME", labels[a]);
          return n;
        }
        snprintf(out[n++], 25, "%d %s%s", d, labels[a],
                 a == ACT_TRANSFER && m->extensions && call_can_transfer(m) ? " 6 EXT" : "");
      }
      snprintf(out[n++], 25, "9 VOLUME");
      return n;
    }
    case MENU_MISSED: {
      if (!m->missed_n) {
        snprintf(out[0], 25, "NO MISSED CALLS");
        return 1;
      }
      int i = m->missed_index % m->missed_n;
      snprintf(out[0], 25, "MISSED %d OF %d", i + 1, m->missed_n);
      snprintf(out[1], 25, "%s", m->missed_from[i]);
      upper(out[1]);
      snprintf(out[2], 25, "%s", m->missed_line[i]);
      bool back = m->missed_id[i][0];
      if (back && m->missed_n > 1) snprintf(out[3], 25, "1 CALL BACK 2 NEXT");
      else if (back) snprintf(out[3], 25, "1 CALL BACK");
      else snprintf(out[3], 25, "%s", m->missed_n > 1 ? "2 NEXT" : "CALL BACK IN APP");
      snprintf(out[4], 25, "3 CLEAR ALL");
      return 5;
    }
    case MENU_CHECK:  // drawn as a page (main.c); these lines are the fallback
      snprintf(out[0], 25, "PHONE CHECK");
      snprintf(out[1], 25, "1 SELF-TEST");
      return 2;
    case MENU_VOICEMAIL:
      if (m->voicemail > 0) snprintf(out[0], 25, "%d NEW VOICEMAIL", m->voicemail);
      else snprintf(out[0], 25, "NO NEW VOICEMAIL");
      if (m->can_play) {  // missed calls and call backs are on 5
        snprintf(out[1], 25, "%s", m->voicemail > 0 ? "1 PLAY 3 CLEAR" : "1 PLAY");
        return 2;
      }
      snprintf(out[1], 25, "%s", m->voicemail > 0 ? (m->kids ? "ASK A GROWN-UP" : "PLAY IN APP") : "");
      return m->voicemail > 0 ? 2 : 1;
    case MENU_VOLUME: {
      static const char *levels[] = {"", "SOFT", "MEDIUM", "LOUD"};
      snprintf(out[0], 25, "VOLUME %d/%d", audio_volume(), VOLUME_MAX);
      snprintf(out[1], 25, "1 LOWER 2 LOUDER");
      snprintf(out[2], 25, "RING %s %s", levels[signals_ring_level()],
               signals_ring_style_name(signals_ring_style()));
      snprintf(out[3], 25, "4 RING 5 STYLE");
      return 4;
    }
    case MENU_ABOUT: {
      const char *const *w = identity_fingerprint();
      snprintf(out[0], 25, "FW %.21s", FW_VERSION);
      snprintf(out[1], 25, "%s %s", w[0], w[1]);
      snprintf(out[2], 25, "%s %s", w[2], w[3]);
      upper(out[1]);
      upper(out[2]);
      return 3;
    }
    case MENU_WIFI:
    case MENU_SERVER: {  // one screen: the Wi-Fi network and the server (3, or 4)
      char ssid[33] = "", ip[16] = "", url[PROV_SERVER_MAX], host[64];
      int rssi = 0;
      net_wifi_info(ssid, sizeof ssid, &rssi, ip, sizeof ip);
      net_server_url(url, sizeof url);
      if (!strcmp(url, PROV_HUB_URL)) snprintf(host, sizeof host, "PUBLIC HUB");
      else if (url[0]) prov_server_host(url, host, sizeof host);
      else snprintf(host, sizeof host, "NOT SET");
      snprintf(out[0], 25, "NETWORK");
      if (!ssid[0]) snprintf(out[1], 25, "WI-FI NOT SET");
      else if (!net_wifi_up()) snprintf(out[1], 25, "%.15s OFFLINE", ssid);
      else snprintf(out[1], 25, "%.16s %d", ssid, rssi);
      snprintf(out[2], 25, "%.24s", host);
      upper(out[1]);
      upper(out[2]);
      if (m->setup == SETUP_HIDDEN) snprintf(out[3], 25, "ADMIN: SEE GUIDE");
      else if (m->confirm) snprintf(out[3], 25, "PRESS 1 AGAIN");
      else snprintf(out[3], 25, "1 CHANGE");
      return 4;
    }
#if CONFIG_OLP_LABS
    case MENU_LABS:
      return labs_menu_lines(out);
#endif
    case MENU_EXT:
      snprintf(out[0], 25, "%s %s_", m->ext_transfer ? "TO EXT" : "EXT", m->ext);
      snprintf(out[1], 25, "%s", m->ext_transfer ? "MENU TRANSFERS" : "MENU DIALS");
      snprintf(out[2], 25, "BACK DELETES");
      return 3;
    default:
      return 0;
  }
}
