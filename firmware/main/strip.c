#include "strip.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

#define MISSED_CYCLE_MS 3000

static void clip(char *dst, const char *src) {
  int i = 0;
  for (; src[i] && i < STATUS_MAX; i++) dst[i] = (char)toupper((unsigned char)src[i]);
  dst[i] = '\0';
}

static int set1(char out[2][STATUS_MAX + 1], const char *a) {
  clip(out[0], a);
  return 1;
}
static int set2(char out[2][STATUS_MAX + 1], const char *a, const char *b) {
  clip(out[0], a);
  clip(out[1], b);
  return 2;
}

/** "CALLING MOM" on one line when it fits, else "CALLING" / "GRANDMA JOSEPHINE". */
static int with_name(char out[2][STATUS_MAX + 1], const char *prefix, const char *name,
                     const char *suffix) {
  char one[96];
  snprintf(one, sizeof one, "%s%s%s%s%s", prefix, (*prefix && *name) ? " " : "", name,
           (*suffix && *name) ? " " : "", suffix);
  if (strlen(one) <= STATUS_WIDTH) return set1(out, one);
  return *prefix ? set2(out, prefix, name) : set2(out, name, suffix);
}

static void clock_text(char *buf, size_t n, int64_t ms) {
  long total = ms < 0 ? 0 : (long)(ms / 1000);
  long mm = total / 60;
  if (mm >= 100) snprintf(buf, n, "%ldH%02ld", mm / 60, mm % 60);
  else snprintf(buf, n, "%02ld:%02ld", mm, total % 60);
}

static const char *end_text(const char *r) {
  if (!r || !*r) return NULL;
  if (!strcmp(r, "denied") || !strcmp(r, "voicemail")) return "NOT ALLOWED";
  if (!strcmp(r, "busy")) return "BUSY";
  if (!strcmp(r, "timeout")) return "NO ANSWER";
  if (!strcmp(r, "unreachable")) return "UNAVAILABLE";
  if (!strcmp(r, "declined")) return "DECLINED";
  if (!strcmp(r, "error")) return "CALL FAILED";
  return NULL;  // hangup, unavailable: no message
}

void strip_owner_line(char *dst, const phone_config_t *c) {
  char buf[96];
  if (!strcmp(c->owner_mode, "personal") && c->owner_person[0])
    snprintf(buf, sizeof buf, "%s'S PHONE", c->owner_person);
  else
    snprintf(buf, sizeof buf, "%s: %s", !strcmp(c->owner_mode, "lounge") ? "LOUNGE" : "KIDS",
             c->owner_space);
  clip(dst, buf);
}

int strip_lines(const strip_input_t *in, char out[2][STATUS_MAX + 1]) {
  const phone_state_t *s = in->state;
  const char *name = in->active_label ? in->active_label : "";
  char buf[48];

  if (in->pairing_code) {
    snprintf(buf, sizeof buf, "PAIR %.3s %.3s", in->pairing_code, in->pairing_code + 3);
    return set2(out, buf, "ENTER IN APP");
  }
  if (in->no_wifi) return set2(out, "NO WI-FI", "PRESS MENU 3");
  if (in->connection == CONN_OFFLINE)
    return set2(out, "OFFLINE", in->wifi_problem ? in->wifi_problem : "RECONNECTING");
  if (in->connection == CONN_CONNECTING) return set1(out, "CONNECTING");

  switch (s->kind) {
    case PH_DIALING:
      return with_name(out, "CALLING", name, "");
    case PH_INCOMING: {
      int n = with_name(out, "", s->from, "CALLING");
      if (n == 1) clip(out[1], "LIFT TO ANSWER");
      return 2;
    }
    case PH_INCALL:
      if (s->transfer_pending) return set2(out, "TRANSFER TO?", "PRESS A KEY");
      if (s->held_by_them) return *name ? set2(out, "ON HOLD", name) : set1(out, "ON HOLD");
      if (!s->connected || in->call_started_ms < 0)
        return *name ? set2(out, "CONNECTING", name) : set1(out, "CONNECTING");
      {
        char t[16];
        clock_text(t, sizeof t, in->now_ms - in->call_started_ms);
        snprintf(buf, sizeof buf, "%s %s", s->recorded ? "REC" : "IN CALL", t);
        return *name ? set2(out, buf, name) : set1(out, buf);
      }
    case PH_INROOM:
      if (!s->room_id[0]) return set1(out, "JOINING ROOM");
      return set2(out, s->recorded ? "REC IN ROOM" : "IN ROOM", s->muted ? "MUTED" : "");
    case PH_OFFHOOK: {
      if (s->held[0]) return *name ? set2(out, "ON HOLD", name) : set2(out, "CALL ON HOLD", "MENU 1 RESUMES");
      const char *t = end_text(s->last_end);
      return t ? set2(out, t, "PRESS A KEY") : set1(out, "PRESS A KEY");
    }
    case PH_VOICEMAIL:
      if (in->vm_stage == VM_RECORDING) {
        char t[16];
        clock_text(t, sizeof t, in->vm_remaining_ms);
        snprintf(buf, sizeof buf, "RECORDING %s", t);
        return set2(out, buf, "HANG UP TO SEND");
      }
      if (in->vm_stage == VM_FAILED) return set2(out, "MESSAGE NOT SENT", "HANG UP");
      if (in->vm_stage == VM_SENDING) return set1(out, "SENDING MESSAGE");
      if (in->vm_stage == VM_SENT) return set2(out, "MESSAGE SENT", "HANG UP");
      return set2(out, "LEAVE A MESSAGE", *name ? name : s->from);
    default:
      break;
  }

  // Just hung up after leaving a message.
  if (in->vm_stage == VM_SENDING) return set1(out, "SENDING MESSAGE");
  if (in->vm_stage == VM_SENT) return set1(out, "MESSAGE SENT");
  if (in->vm_stage == VM_FAILED) return set1(out, "MESSAGE NOT SENT");

  const phone_config_t *c = in->config;
  char quiet[STATUS_MAX + 1] = "";
  if (c && c->quiet) {
    if (c->quiet_until[0]) snprintf(buf, sizeof buf, "QUIET TIL %s", c->quiet_until);
    else snprintf(buf, sizeof buf, "QUIET HOURS");
    clip(quiet, buf);
  }
  if (c && c->missed_count > 0) {
    const char *newest = c->missed[0];
    char single[64], summary[64];
    snprintf(single, sizeof single, "MISSED %s", newest);
    if (c->missed_count == 1)
      snprintf(summary, sizeof summary, "%s", strlen(single) <= STATUS_WIDTH ? single : "MISSED CALL");
    else
      snprintf(summary, sizeof summary, "%d MISSED CALLS", c->missed_count);
    if (quiet[0]) return set2(out, quiet, summary);
    if (c->missed_count == 1) {
      const char *next = !c->owner_mode[0] || !strcmp(c->owner_mode, "kids") ? "ASK A GROWN-UP"
                                                                               : "PLAY IN APP";
      return strlen(single) <= STATUS_WIDTH ? set2(out, single, next)
                                            : set2(out, "MISSED CALL", newest);
    }
    int shown = c->missed_count < MAX_MISSED ? c->missed_count : MAX_MISSED;
    const char *who = c->missed[(in->now_ms / MISSED_CYCLE_MS) % shown];
    return set2(out, summary, who);
  }
  char ready[32] = "READY";
  if (in->local_minute >= 0 && in->local_minute < 24 * 60)
    snprintf(ready, sizeof ready, "READY %02d:%02d", in->local_minute / 60, in->local_minute % 60);
  const char *first = quiet[0] ? quiet : ready;
  if (c && c->owner_mode[0]) {
    char owner[STATUS_MAX + 1];
    strip_owner_line(owner, c);
    return set2(out, first, owner);
  }
  return set1(out, first);
}
