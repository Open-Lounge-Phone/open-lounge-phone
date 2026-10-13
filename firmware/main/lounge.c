#include "lounge.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

static void upper(char *dst, size_t n, const char *src) {
  size_t i = 0;
  for (; src && src[i] && i + 1 < n; i++) dst[i] = (char)toupper((unsigned char)src[i]);
  dst[i] = '\0';
}

void lounge_init(lounge_t *l) {
  bool on = l->on;
  memset(l, 0, sizeof *l);
  l->on = on;
  l->challenge = -1;
  l->last_refresh = -1000000;
}

void lounge_idle(lounge_t *l, const char *nonce, int64_t until_ms) {
  snprintf(l->nonce, sizeof l->nonce, "%s", nonce ? nonce : "");
  l->nonce_until = until_ms;
  l->challenge = -1;
}

void lounge_challenge(lounge_t *l, int index, int64_t until_ms) {
  l->challenge = index;
  l->challenge_until = until_ms;
}

void lounge_session(lounge_t *l, const char *name, bool open_to_chat) {
  l->session = true;
  upper(l->name, sizeof l->name, name);
  l->open_to_chat = open_to_chat;
  l->challenge = -1;
}

void lounge_ended(lounge_t *l, const char *reason, int64_t now_ms) {
  bool was = l->session;
  lounge_init(l);  // forget the person: name, chat, the code they used
  if (!was) return;
  snprintf(l->note[0], sizeof l->note[0], "SIGNED OUT");
  snprintf(l->note[1], sizeof l->note[1], "%s",
           reason && !strcmp(reason, "idle")       ? "TIME'S UP"
           : reason && !strcmp(reason, "replaced") ? "SOMEONE ELSE"
                                                   : "SEE YOU");
  l->note_until = now_ms + LOUNGE_NOTE_MS;
}

void lounge_tick(lounge_t *l, int64_t now_ms) {
  if (l->challenge >= 0 && now_ms >= l->challenge_until) l->challenge = -1;
}

static void put(char out[2][41], int i, const char *a) { snprintf(out[i], 41, "%.40s", a); }

int lounge_lines(const lounge_t *l, bool idle, bool offhook, char out[2][41], int64_t now_ms) {
  if (!l->on) return 0;
  char buf[48];
  if (l->challenge >= 0) {
    snprintf(buf, sizeof buf, "PRESS KEY %d", l->challenge == 9 ? 0 : l->challenge + 1);
    put(out, 0, buf);
    put(out, 1, "TO START");
    return 2;
  }
  if (!idle && !offhook) return 0;  // a call: the usual status
  if (l->session) {
    if (offhook) return 0;  // the key map shows their people
    snprintf(buf, sizeof buf, "HI %s", l->name);
    put(out, 0, buf);
    put(out, 1, l->open_to_chat ? "OPEN TO CHAT" : "MENU = OPTIONS");
    return 2;
  }
  if (now_ms < l->note_until) {
    put(out, 0, l->note[0]);
    put(out, 1, l->note[1]);
    return 2;
  }
  if (offhook && l->house_line) return 0;  // house-line keys: the key map
  put(out, 0, "SCAN TO USE");
  if (l->here[0]) {
    snprintf(buf, sizeof buf, "HERE: %s", l->here);
    put(out, 1, buf);
  } else {
    put(out, 1, l->house_line ? "OR PRESS A KEY" : "THIS PHONE");
  }
  return 2;
}

bool lounge_show_qr(const lounge_t *l, bool idle, bool menu_open, int64_t now_ms) {
  return l->on && !l->session && l->challenge < 0 && idle && !menu_open && l->nonce[0] &&
         now_ms < l->nonce_until && now_ms >= l->note_until;
}

bool lounge_wants_refresh(lounge_t *l, bool idle, bool menu_open, int64_t now_ms) {
  if (!l->on || l->session || l->challenge >= 0 || !idle || menu_open) return false;
  if (l->nonce[0] && l->nonce_until - now_ms >= LOUNGE_REFRESH_LEAD_MS) return false;
  if (now_ms - l->last_refresh < LOUNGE_REFRESH_LEAD_MS) return false;  // asked just now
  l->last_refresh = now_ms;
  return true;
}

bool lounge_keys_live(const lounge_t *l) { return !l->on || l->session || l->house_line; }
