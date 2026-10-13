#include "labs_ic.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void cpy(char *d, size_t n, const char *s) { snprintf(d, n, "%s", s ? s : ""); }
#define CPY(d, s) cpy((d), sizeof(d), (s))

static void emit(ic_out_t *out, const char *fmt, const char *a, const char *b, const char *c, const char *d) {
  if (!out || out->n >= IC_OUT) return;
  snprintf(out->lines[out->n++], IC_LINE, fmt, a, b, c, d);
}

static void note(ic_t *ic, const char *a, const char *b, int64_t now) {
  CPY(ic->note[0], a);
  CPY(ic->note[1], b);
  ic->note_until = now + IC_NOTE_MS;
}

static void to_idle(ic_t *ic) {
  ic->st = IC_IDLE;
  ic->id = 0;
  ic->peer[0] = '\0';
  ic->peer_ip = 0;
  ic->door = ic->to_all = false;
}

void icom_init(ic_t *ic, const char *me) {
  memset(ic, 0, sizeof *ic);
  CPY(ic->me, me);
  for (char *c = ic->me; *c; c++) {
    *c = (char)toupper((unsigned char)*c);
    if (*c == '|') *c = '/';
  }
}

void icom_hello(const ic_t *ic, ic_out_t *out) { emit(out, "OLP1|HELLO|%s", ic->me, "", "", ""); }

static void idstr(char *b, uint32_t id) { snprintf(b, 12, "%08lx", (unsigned long)id); }

bool icom_call(ic_t *ic, const char *to, bool door, uint32_t id, int64_t now, ic_out_t *out) {
  if (ic->st != IC_IDLE || !to || !*to) return false;
  ic->st = IC_CALLING;
  ic->id = id ? id : 1;
  ic->door = door;
  ic->to_all = !strcmp(to, "*");
  ic->since = now;
  CPY(ic->peer, ic->to_all ? "ALL ROOMS" : to);
  char b[12];
  idstr(b, ic->id);
  emit(out, "OLP1|RING|%s|%s|%s|%s", b, to, ic->me, door ? "door" : "call");
  return true;
}

void icom_chime(const ic_t *ic, const char *text, ic_out_t *out) {
  emit(out, "OLP1|CHIME|%s|%s", ic->me, text && *text ? text : "CHIME", "", "");
}

static void bye(ic_t *ic, ic_out_t *out) {
  char b[12];
  idstr(b, ic->id);
  emit(out, "OLP1|BYE|%s|%s", b, ic->me, "", "");
}

void icom_hook(ic_t *ic, bool up, int64_t now, ic_out_t *out) {
  if (up && ic->st == IC_RINGING) {          // lift to answer
    char b[12];
    idstr(b, ic->id);
    emit(out, "OLP1|ANSWER|%s|%s", b, ic->me, "", "");
    ic->st = IC_TALK;
    ic->since = now;
    return;
  }
  if (!up && (ic->st == IC_TALK || (ic->st == IC_CALLING && !ic->door))) {
    bye(ic, out);
    to_idle(ic);
  }
}

void icom_cancel(ic_t *ic, ic_out_t *out) {
  if (ic->st == IC_CALLING || ic->st == IC_TALK) {
    bye(ic, out);
    to_idle(ic);
  }
}

/** Splits "A|B|C" in place; returns the field count. */
static int split(char *s, char **f, int max) {
  int n = 0;
  while (s && n < max) {
    f[n++] = s;
    char *p = strchr(s, '|');
    if (!p) break;
    *p = '\0';
    s = p + 1;
  }
  return n;
}

static void seen(ic_t *ic, const char *name, uint32_t ip, int64_t now) {
  if (!name || !*name || !strcmp(name, ic->me)) return;
  int slot = -1, oldest = 0;
  for (int i = 0; i < IC_PEERS; i++) {
    if (!strcmp(ic->peers[i].name, name)) { slot = i; break; }
    if (!ic->peers[i].name[0] && slot < 0) slot = i;
    if (ic->peers[i].seen < ic->peers[oldest].seen) oldest = i;
  }
  if (slot < 0) slot = oldest;
  CPY(ic->peers[slot].name, name);
  ic->peers[slot].ip = ip;
  ic->peers[slot].seen = now;
}

void icom_msg(ic_t *ic, uint32_t ip, const char *line, int64_t now, ic_out_t *out) {
  char buf[IC_LINE], *f[6];
  CPY(buf, line);
  int n = split(buf, f, 6);
  if (n < 2 || strcmp(f[0], "OLP1")) return;
  const char *t = f[1];
  uint32_t id = n > 2 ? (uint32_t)strtoul(f[2], NULL, 16) : 0;
  if (!strcmp(t, "HELLO") && n >= 3) {
    seen(ic, f[2], ip, now);
  } else if (!strcmp(t, "RING") && n >= 6) {
    const char *to = f[3], *from = f[4];
    seen(ic, from, ip, now);
    if (!strcmp(from, ic->me)) return;                       // our own broadcast
    bool mine = !strcmp(to, "*") || !strcmp(to, ic->me);
    if (!mine) return;
    if (ic->st != IC_IDLE) {
      if (strcmp(to, "*")) emit(out, "OLP1|BUSY|%s|%s", f[2], ic->me, "", "");
      return;
    }
    ic->st = IC_RINGING;
    ic->id = id;
    ic->door = !strcmp(f[5], "door");
    ic->to_all = !strcmp(to, "*");
    CPY(ic->peer, from);
    ic->peer_ip = ip;
    ic->since = now;
  } else if (!strcmp(t, "ANSWER") && n >= 4) {
    seen(ic, f[3], ip, now);
    if (id != ic->id) return;
    if (ic->st == IC_CALLING) {                              // someone took our call
      ic->st = IC_TALK;
      CPY(ic->peer, f[3]);
      ic->peer_ip = ip;
      ic->since = now;
    } else if (ic->st == IC_RINGING && strcmp(f[3], ic->me)) {
      note(ic, ic->peer, "ANSWERED", now);                   // another room got it
      to_idle(ic);
    }
  } else if (!strcmp(t, "BUSY") && n >= 4) {
    if (id == ic->id && ic->st == IC_CALLING && !ic->to_all) {
      note(ic, f[3], "IS BUSY", now);
      to_idle(ic);
    }
  } else if (!strcmp(t, "BYE") && n >= 4) {
    if (id == ic->id && ic->st != IC_IDLE && strcmp(f[3], ic->me)) {
      bool was_talking = ic->st == IC_TALK;
      if (was_talking) note(ic, f[3], "HUNG UP", now);
      to_idle(ic);
    }
  } else if (!strcmp(t, "CHIME") && n >= 4) {
    seen(ic, f[2], ip, now);
    if (!strcmp(f[2], ic->me)) return;
    note(ic, f[3], f[2], now);
    ic->chimed = true;
  }
}

void icom_tick(ic_t *ic, int64_t now, ic_out_t *out) {
  if (ic->st == IC_CALLING && now - ic->since > IC_RING_MS) {
    bye(ic, out);
    note(ic, ic->peer, "NO ANSWER", now);
    to_idle(ic);
  } else if (ic->st == IC_RINGING && now - ic->since > IC_RING_MS + 5000) {
    to_idle(ic);
  }
}

int icom_peer_count(const ic_t *ic, int64_t now) {
  int n = 0;
  for (int i = 0; i < IC_PEERS; i++)
    if (ic->peers[i].name[0] && now - ic->peers[i].seen < IC_PEER_MS) n++;
  return n;
}

int icom_lines(const ic_t *ic, int64_t now, char out[2][41]) {
  switch (ic->st) {
    case IC_CALLING:
      snprintf(out[0], 41, "%s", ic->door ? "RINGING THE HOUSE" : "CALLING");
      snprintf(out[1], 41, "%s", ic->door ? "LIFT THE HANDSET TO TALK" : ic->peer);
      return 2;
    case IC_RINGING:
      snprintf(out[0], 41, "%s", ic->peer);
      snprintf(out[1], 41, "%s", "LIFT TO ANSWER");
      return 2;
    case IC_TALK:
      snprintf(out[0], 41, "%s", "INTERCOM");
      snprintf(out[1], 41, "%s", ic->peer);
      return 2;
    default:
      if (now < ic->note_until) {
        snprintf(out[0], 41, "%s", ic->note[0]);
        snprintf(out[1], 41, "%s", ic->note[1]);
        return 2;
      }
      return 0;
  }
}
