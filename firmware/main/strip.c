#include "strip.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

#define MISSED_CYCLE_MS 3000
// A how-to hint (BACK: SILENCE, MENU 3: MUTE) takes the second line every third turn of this long.
#define HINT_CYCLE_MS 3000

static bool hint_now(int64_t now) { return (now / HINT_CYCLE_MS) % 3 == 2; }

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

void strip_addon_label(char *dst, const char *name) {
  char buf[96];
  int room = STATUS_WIDTH - (int)strlen(" - ADD-ON");
  snprintf(buf, sizeof buf, "%.*s - ADD-ON", room, name);
  clip(dst, buf);
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
      // Waiting in a public line's queue: key 1 leaves a voicemail instead, key 2 asks for a
      // call back (when the line offers them).
      if (s->queued) {
        if (s->queue_pos > 0) snprintf(buf, sizeof buf, "IN LINE %d", s->queue_pos);
        else snprintf(buf, sizeof buf, "WAITING IN LINE");
        const char *keys = s->queue_vm && s->queue_cb ? "1 VM 2 CALL BACK"
                           : s->queue_vm              ? "1 VOICEMAIL"
                           : s->queue_cb              ? "2 CALL ME BACK"
                           : *name                    ? name
                                                      : "PLEASE WAIT";
        return set2(out, buf, keys);
      }
      return with_name(out, "CALLING", name, "");
    case PH_INCOMING: {
      if (s->callback) return set2(out, s->from, "CALLS YOU BACK");
      if (s->addon) {  // always marked: the whole label when it fits, else ADD-ON CALLING below
        snprintf(buf, sizeof buf, "%.30s - ADD-ON", s->from);
        if (strlen(buf) <= STATUS_WIDTH) return set2(out, buf, "LIFT TO ANSWER");
        return set2(out, s->from, "ADD-ON CALLING");
      }
      int n = with_name(out, "", s->from, "CALLING");
      // In turn on the second line: BACK silences the ringer here (until it's silenced).
      if (n == 1) clip(out[1], !s->silenced && hint_now(in->now_ms) ? "BACK: SILENCE" : "LIFT TO ANSWER");
      return 2;
    }
    case PH_INCALL:
      if (s->transfer_pending) return set2(out, "TRANSFER TO?", "PRESS A KEY");
      if (s->waiting_id[0]) {  // call waiting: who, and the keys (a long name takes turns)
        char who[STATUS_MAX + 1];
        if (s->waiting_addon) strip_addon_label(who, s->waiting_from);
        else clip(who, s->waiting_from);
        snprintf(buf, sizeof buf, "WAITING: %.24s", who);
        if (strlen(buf) <= STATUS_WIDTH) return set2(out, buf, "1 TAKE 2 IGNORE");
        return set2(out, "CALL WAITING", hint_now(in->now_ms) ? "1 TAKE 2 IGNORE" : who);
      }
      if (s->held_by_them) return *name ? set2(out, "ON HOLD", name) : set1(out, "ON HOLD");
      if (!s->connected || in->call_started_ms < 0)
        return *name ? set2(out, "CONNECTING", name) : set1(out, "CONNECTING");
      // Never a timer while there's no audio: say it's coming back.
      if (in->reconnecting) return *name ? set2(out, "RECONNECTING", name) : set1(out, "RECONNECTING");
      {
        char t[16];
        clock_text(t, sizeof t, in->now_ms - in->call_started_ms);
        const char *what = s->muted ? (s->recorded ? "REC MUTED" : "MUTED")
                                    : (s->recorded ? "REC" : "IN CALL");
        snprintf(buf, sizeof buf, "%s %s", what, t);
        // In turn with the name: how to mute or unmute (MENU 3, docs/phone-ux.md).
        if (hint_now(in->now_ms)) return set2(out, buf, s->muted ? "MENU 3: UNMUTE" : "MENU 3: MUTE");
        return *name ? set2(out, buf, name) : set1(out, buf);
      }
    case PH_INROOM:
      if (!s->room_id[0]) return set1(out, "JOINING ROOM");
      return set2(out, s->recorded ? "REC IN ROOM" : "IN ROOM", s->muted ? "MUTED" : "");
    case PH_OFFHOOK: {
      if (s->lost) return set2(out, "CONNECTION LOST", "PRESS A KEY");
      if (s->held[0]) return *name ? set2(out, "ON HOLD", name) : set2(out, "CALL ON HOLD", "MENU 1 RESUMES");
      if (s->callback) return set2(out, "PLACE KEPT", "WE'LL CALL BACK");
      // A free Lounge phone tried a public line: only someone signed in can call one.
      if (s->sign_in) return set2(out, "SIGN IN TO CALL", "PRESS A KEY");
      // Why it didn't go through, when the server said (e.g. ADD-ON OFFLINE, ON ANOTHER CALL).
      const char *why = phone_why_text(s->why);
      if (why) return set2(out, why, "PRESS A KEY");
      const char *t = end_text(s->last_end);
      if (t) return set2(out, t, "PRESS A KEY");
      // More than one page of keys: which page is on screen, and how to turn it.
      int pages[MAX_KEY_PAGES];
      int n = in->config ? strip_key_pages(in->config, pages) : 1;
      if (n > 1) {
        snprintf(buf, sizeof buf, "PAGE %d/%d", s->page > 1 ? s->page : 1, pages[n - 1]);
        return set2(out, buf, "BACK: NEXT PAGE");
      }
      return set1(out, "PRESS A KEY");
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
  // The daily check-in: asked until I'm OK (1, handset down); thanked once the server has it.
  if (in->checked_in) return set2(out, "THANK YOU", "CHECKED IN");
  if (c && c->checkin_by[0] && !c->checkin_done) {
    snprintf(buf, sizeof buf, "CHECK IN BY %s", c->checkin_by);
    return set2(out, c->checkin_alerted ? "CHECK-IN MISSED" : buf, "PRESS 1: I'M OK");
  }
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
    // A public line's call back nobody took: there's no message to play, just its name.
    if (c->missed_count == 1 && c->missed_callback[0]) return set2(out, "MISSED CALL BACK", newest);
    if (c->missed_count == 1) {
      // A missed call (no message): it's on MENU 5. A message: where to listen.
      const char *next = c->missed_call[0]                                     ? "MENU 5: MISSED"
                         : !c->owner_mode[0] || !strcmp(c->owner_mode, "kids") ? "ASK A GROWN-UP"
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

int strip_key_pages(const phone_config_t *c, int out[MAX_KEY_PAGES]) {
  int n = 0;
  out[n++] = 1;
  for (int page = 2; page <= MAX_KEY_PAGES; page++) {
    for (int slot = 0; slot < KEYS_PER_PAGE; slot++) {
      if (c->labels[(page - 1) * KEYS_PER_PAGE + slot][0]) {
        out[n++] = page;
        break;
      }
    }
  }
  return n;
}
