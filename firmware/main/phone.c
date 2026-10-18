#include "phone.h"

#include <stdio.h>
#include <string.h>

static void cpy(char *dst, size_t n, const char *src) { snprintf(dst, n, "%s", src ? src : ""); }
#define CPY(dst, src) cpy((dst), sizeof(dst), (src))

static cJSON *msg(const char *t) {
  cJSON *m = cJSON_CreateObject();
  cJSON_AddStringToObject(m, "t", t);
  return m;
}

static const char *str(const cJSON *o, const char *key) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
  return cJSON_IsString(v) ? v->valuestring : NULL;
}

static void emit_hook(phone_emit_fn emit, bool up) {
  cJSON *m = msg("hook");
  cJSON_AddStringToObject(m, "state", up ? "up" : "down");
  emit(m);
}

static void emit_call(phone_emit_fn emit, const char *t, const char *call_id) {
  cJSON *m = msg(t);
  cJSON_AddStringToObject(m, "callId", call_id);
  emit(m);
}

static void emit_room_leave(phone_emit_fn emit, const char *room_id) {
  cJSON *m = msg("room.leave");
  cJSON_AddStringToObject(m, "roomId", room_id);
  emit(m);
}

static void to_idle(phone_state_t *s) { phone_init(s); }

static void to_offhook(phone_state_t *s, const char *last_end) {
  phone_init(s);
  s->kind = PH_OFFHOOK;
  CPY(s->last_end, last_end);
}

// Mirrors packages/core/src/refusals.ts (notes and their status lines; a test keeps them equal).
static const char *const WHY_NOTES[][2] = {
    {"You're already on a call", "ON ANOTHER CALL"},
    {"That add-on isn't connected right now", "ADD-ON OFFLINE"},
    {"That add-on doesn't take calls", "TAKES NO CALLS"},
    {"That add-on is on as many calls as it takes", "ADD-ON BUSY"},
    {"You have no add-on by that name on that server", "NO SUCH ADD-ON"},
    {"Add-ons are off on that server", "ADD-ONS ARE OFF"},
    {"You can't call that address", "CAN'T CALL THAT"},
    {"That phone is waiting for a grown-up's OK", "WAITING FOR OK"},
    {"Until a grown-up says OK, this phone calls only them", "ASK A GROWN-UP"},
};

int phone_why(const char *note) {
  if (!note) return 0;
  for (size_t i = 0; i < sizeof WHY_NOTES / sizeof WHY_NOTES[0]; i++) {
    if (!strcmp(note, WHY_NOTES[i][0])) return (int)i + 1;
  }
  return 0;
}

const char *phone_why_text(int why) {
  int n = (int)(sizeof WHY_NOTES / sizeof WHY_NOTES[0]);
  return why >= 1 && why <= n ? WHY_NOTES[why - 1][1] : NULL;
}

void phone_init(phone_state_t *s) {
  memset(s, 0, sizeof(*s));
  s->kind = PH_IDLE;
  s->button = -1;
}

const char *phone_kind_name(phone_kind_t k) {
  static const char *names[] = {"idle",   "offhook", "dialing",  "incoming",
                                "incall", "inroom",  "voicemail"};
  return names[k];
}

void phone_hook(phone_state_t *s, bool up, phone_emit_fn emit) {
  if (up) {
    if (s->kind == PH_IDLE) {
      emit_hook(emit, true);
      to_offhook(s, "");
    } else if (s->kind == PH_INCOMING) {
      char id[65];
      CPY(id, s->call_id);
      emit_hook(emit, true);
      emit_call(emit, "call.answer", id);
      phone_init(s);
      s->kind = PH_INCALL;
      CPY(s->call_id, id);
    }
    return;  // already up
  }
  // Hook down always returns to idle, hanging up whatever is in progress.
  if (s->kind == PH_INCOMING || s->kind == PH_IDLE) return;  // already down
  if ((s->kind == PH_DIALING || s->kind == PH_INCALL) && s->call_id[0]) {
    emit_call(emit, "call.hangup", s->call_id);
  }
  if ((s->kind == PH_DIALING || s->kind == PH_INCALL || s->kind == PH_OFFHOOK) && s->held[0])
    emit_call(emit, "call.hangup", s->held);  // a held call too
  if (s->kind == PH_INROOM && s->room_id[0]) emit_room_leave(emit, s->room_id);
  emit_hook(emit, false);
  if (s->kind == PH_INCALL && s->waiting_id[0]) {  // a call was waiting: now it rings
    char id[65], from[25];
    bool addon = s->waiting_addon;
    CPY(id, s->waiting_id);
    CPY(from, s->waiting_from);
    phone_init(s);
    s->kind = PH_INCOMING;
    CPY(s->call_id, id);
    CPY(s->from, from);
    s->addon = addon;
    return;
  }
  to_idle(s);
}

void phone_hangup(phone_state_t *s, const char *reason, phone_emit_fn emit) {
  if ((s->kind == PH_DIALING || s->kind == PH_INCALL) && s->call_id[0]) {
    char held[65];
    CPY(held, s->held);
    emit_call(emit, "call.hangup", s->call_id);
    to_offhook(s, reason);
    CPY(s->held, held);
  }
}

void phone_silence(phone_state_t *s) {
  if (s->kind == PH_INCOMING) s->silenced = true;
}

bool phone_repeated_end(phone_ends_t *t, const cJSON *m) {
  const char *type = str(m, "t"), *state = str(m, "state"), *id = str(m, "callId");
  if (!type || strcmp(type, "call.state") || !state || strcmp(state, "ended") || !id || !id[0])
    return false;
  for (int i = 0; i < 4; i++)
    if (!strcmp(t->ids[i], id)) return true;
  memmove(t->ids[1], t->ids[0], sizeof t->ids[0] * 3);
  CPY(t->ids[0], id);
  return false;
}

void phone_lost(phone_state_t *s, phone_emit_fn emit) {
  if (s->kind != PH_INCALL || !s->call_id[0]) return;
  char held[65];
  CPY(held, s->held);
  cJSON *m = msg("call.hangup");
  cJSON_AddStringToObject(m, "callId", s->call_id);
  cJSON_AddBoolToObject(m, "lost", true);
  emit(m);
  to_offhook(s, "error");
  CPY(s->held, held);
  s->lost = true;
}

void phone_page(phone_state_t *s, const int *pages, int n) {
  // Only the speed-dial screen pages (with a call on hold the screen says so instead).
  if (s->kind != PH_OFFHOOK || s->held[0] || n < 2) return;
  int cur = s->page > 1 ? s->page : 1, next = pages[0];
  for (int i = 0; i < n; i++) {
    if (pages[i] > cur) {
      next = pages[i];
      break;
    }
  }
  // Turning the page moves on from the last call's result (and its busy tone).
  to_offhook(s, "");
  s->page = next > 1 ? next : 0;
}

void phone_key(phone_state_t *s, int slot, int page, phone_emit_fn emit) {
  if (s->kind != PH_OFFHOOK) {
    phone_button(s, slot, emit);
    return;
  }
  if (page < 1) page = s->page > 1 ? s->page : 1;
  char held[65];
  CPY(held, s->held);
  cJSON *m = msg("button");
  cJSON_AddNumberToObject(m, "index", slot);
  if (page > 1) cJSON_AddNumberToObject(m, "page", page);
  emit(m);
  phone_init(s);
  s->kind = PH_DIALING;
  s->button = (page - 1) * 10 + slot;
  CPY(s->held, held);
}

void phone_button(phone_state_t *s, int index, phone_emit_fn emit) {
  if (s->kind == PH_OFFHOOK) {
    phone_key(s, index, 0, emit);
    return;
  }
  // Waiting in a public line's queue: key 1 leaves a voicemail instead (when the line offers it).
  if (s->kind == PH_DIALING && s->queued && s->queue_vm && s->call_id[0] && index == 0) {
    emit_call(emit, "call.voicemail", s->call_id);
    return;
  }
  // …and key 2 asks the line to call back instead (the place in line is kept).
  if (s->kind == PH_DIALING && s->queued && s->queue_cb && s->call_id[0] && index == 1) {
    emit_call(emit, "call.callback", s->call_id);
    return;
  }
  // Call waiting: 1 takes it, 2 ignores it. One call has audio at a time on this phone, so taking
  // it ends the call you're in (docs/phone-ux.md; the browser phone holds it instead).
  if (s->kind == PH_INCALL && s->waiting_id[0] && !s->transfer_pending && index <= 1) {
    if (index == 1) {
      s->waiting_id[0] = '\0';
      return;
    }
    char id[65], from[25];
    bool addon = s->waiting_addon;
    CPY(id, s->waiting_id);
    CPY(from, s->waiting_from);
    emit_call(emit, "call.hangup", s->call_id);
    if (s->held[0]) emit_call(emit, "call.hangup", s->held);
    emit_call(emit, "call.answer", id);
    phone_init(s);
    s->kind = PH_INCALL;
    CPY(s->call_id, id);
    CPY(s->from, from);
    s->addon = addon;
    return;
  }
  if (s->kind == PH_INCALL && s->transfer_pending) {
    s->transfer_pending = false;
    cJSON *m = msg("call.transfer");
    cJSON_AddStringToObject(m, "callId", s->call_id);
    cJSON *to = cJSON_AddObjectToObject(m, "to");
    cJSON_AddNumberToObject(to, "button", index);
    emit(m);
    return;
  }
  // In a room any key says "still here" (the answer to the idle warning).
  if (s->kind == PH_INROOM && s->room_id[0]) {
    cJSON *m = msg("room.here");
    cJSON_AddStringToObject(m, "roomId", s->room_id);
    emit(m);
  }
  // Keys only dial with the handset up and nothing else going on.
}

void phone_extension(phone_state_t *s, const char *number, phone_emit_fn emit) {
  if (s->kind != PH_OFFHOOK || !number) return;  // dials only with the handset up and idle
  char held[65];
  CPY(held, s->held);
  cJSON *m = msg("call.extension");
  cJSON_AddStringToObject(m, "number", number);
  emit(m);
  phone_init(s);
  s->kind = PH_DIALING;
  s->button = -1;
  CPY(s->held, held);
}

void phone_call_back(phone_state_t *s, const char *id, phone_emit_fn emit) {
  if (s->kind != PH_OFFHOOK || !id || !id[0]) return;  // only with the handset up and idle
  char held[65];
  CPY(held, s->held);
  cJSON *m = msg("call.back");
  cJSON_AddStringToObject(m, "id", id);
  emit(m);
  phone_init(s);
  s->kind = PH_DIALING;
  s->button = -1;
  CPY(s->held, held);
}

void phone_transfer_extension(phone_state_t *s, const char *number, phone_emit_fn emit) {
  if (s->kind != PH_INCALL || !s->connected || s->held[0] || !number) return;
  s->transfer_pending = false;
  cJSON *m = msg("call.transfer");
  cJSON_AddStringToObject(m, "callId", s->call_id);
  cJSON *to = cJSON_AddObjectToObject(m, "to");
  cJSON_AddStringToObject(to, "extension", number);
  emit(m);
}

/** Room end reason → how it sounds on the handset (roomEndToCall). */
static const char *room_end_to_call(const char *r) {
  if (!r) return "denied";
  if (!strcmp(r, "left") || !strcmp(r, "closed") || !strcmp(r, "idle") || !strcmp(r, "removed"))
    return "hangup";
  if (!strcmp(r, "busy")) return "busy";
  if (!strcmp(r, "unreachable")) return "unreachable";
  if (!strcmp(r, "error")) return "error";
  return "denied";
}

bool phone_server(phone_state_t *s, const cJSON *m, phone_emit_fn emit) {
  const char *t = str(m, "t");
  if (!t) return false;

  if (!strcmp(t, "room.state")) {
    const char *room = str(m, "roomId");
    const char *you = str(m, "you");
    bool muted = false;
    const cJSON *p;
    cJSON_ArrayForEach(p, cJSON_GetObjectItemCaseSensitive(m, "participants")) {
      const char *id = str(p, "id");
      if (id && you && !strcmp(id, you)) muted = cJSON_IsTrue(cJSON_GetObjectItem(p, "muted"));
    }
    if ((s->kind == PH_INROOM && (!s->room_id[0] || !strcmp(s->room_id, room ? room : ""))) ||
        (s->kind == PH_DIALING && !s->call_id[0] && !s->held[0])) {
      phone_init(s);
      s->kind = PH_INROOM;
      CPY(s->room_id, room);
      s->muted = muted;
      s->recorded = cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(m, "recording"));
    } else if (room) {
      emit_room_leave(emit, room);  // not expecting a room: leave it
    }
    return true;
  }
  if (!strcmp(t, "room.ended")) {
    const char *room = str(m, "roomId");
    const char *end = room_end_to_call(str(m, "reason"));
    if (s->kind == PH_INROOM && (!s->room_id[0] || (room && !strcmp(s->room_id, room)))) {
      to_offhook(s, end);
    } else if (s->kind == PH_DIALING && !s->call_id[0] && !room) {
      to_offhook(s, end);
    }
    return true;
  }
  if (!strcmp(t, "call.ringing")) {
    const char *id = str(m, "callId");
    const char *from = str(cJSON_GetObjectItemCaseSensitive(m, "from"), "label");
    if (!id) return true;
    if (s->kind == PH_IDLE) {
      phone_init(s);
      s->kind = PH_INCOMING;
      CPY(s->call_id, id);
      CPY(s->from, from);
      s->callback = cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(m, "callback"));
      const char *kind = str(cJSON_GetObjectItemCaseSensitive(m, "from"), "kind");
      s->addon = kind && !strcmp(kind, "addon");
    } else if (s->call_id[0] && !strcmp(s->call_id, id)) {
      // already this call
    } else if (s->kind == PH_INCALL && s->waiting_id[0] && !strcmp(s->waiting_id, id)) {
      // already waiting
    } else if (s->kind == PH_INCALL && s->connected && !s->held[0] && !s->waiting_id[0] &&
               cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(m, "waiting"))) {
      // Call waiting: in a call, a second call rings softly (one at a time).
      CPY(s->waiting_id, id);
      CPY(s->waiting_from, from);
      const char *kind = str(cJSON_GetObjectItemCaseSensitive(m, "from"), "kind");
      s->waiting_addon = kind && !strcmp(kind, "addon");
    } else {
      // Busy: decline so the caller hears it at once instead of waiting for a timeout.
      emit_call(emit, "call.hangup", id);
    }
    return true;
  }
  if (strcmp(t, "call.state")) return false;

  const char *id = str(m, "callId");
  const char *state = str(m, "state");
  const char *reason = str(m, "reason");
  if (!id || !state) return true;
  bool ended = !strcmp(state, "ended");
  // The waiting call: it ends when the caller gives up (or it goes to voicemail).
  if (s->kind == PH_INCALL && s->waiting_id[0] && !strcmp(s->waiting_id, id)) {
    if (ended) s->waiting_id[0] = '\0';
    return true;
  }
  // The call on hold: it can only end (the other person hung up) while we're elsewhere.
  if (s->held[0] && !strcmp(s->held, id)) {
    if (!ended) return true;
    s->held[0] = '\0';
    if (s->kind == PH_OFFHOOK) to_offhook(s, "hangup");
    return true;
  }
  char held[65];
  CPY(held, s->held);
  switch (s->kind) {
    case PH_DIALING: {
      if (s->call_id[0] && strcmp(s->call_id, id)) break;
      const cJSON *vm = cJSON_GetObjectItemCaseSensitive(m, "voicemail");
      if (ended && cJSON_IsObject(vm) && !held[0]) {
        phone_init(s);
        s->kind = PH_VOICEMAIL;
        CPY(s->from, str(vm, "name"));
        CPY(s->vm_ticket, str(vm, "ticket"));
        const cJSON *max = cJSON_GetObjectItemCaseSensitive(vm, "maxMs");
        s->vm_max_ms = cJSON_IsNumber(max) ? max->valueint : 120000;
      } else if (ended && cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(m, "callback")) &&
                 !held[0]) {
        to_offhook(s, "hangup");  // the line calls back later: the place in line is kept
        s->callback = true;
      } else if (ended) {
        const char *note = str(m, "note");
        to_offhook(s, reason ? reason : "hangup");
        CPY(s->held, held);
        s->sign_in = note && !strcmp(note, PHONE_SIGN_IN_NOTE);
        s->why = phone_why(note);
      } else if (!strcmp(state, "active") || !strcmp(state, "connecting")) {
        phone_init(s);
        s->kind = PH_INCALL;
        CPY(s->call_id, id);
        CPY(s->held, held);
        s->connected = !strcmp(state, "active");
        s->recorded = cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(m, "recording"));
      } else {
        CPY(s->call_id, id);
        // A public line's queue: the place in line; `ringing` without one = ringing again.
        const cJSON *q = cJSON_GetObjectItemCaseSensitive(m, "queue");
        const cJSON *pos = cJSON_IsObject(q) ? cJSON_GetObjectItemCaseSensitive(q, "position") : NULL;
        const cJSON *size = cJSON_IsObject(q) ? cJSON_GetObjectItemCaseSensitive(q, "size") : NULL;
        s->queued = cJSON_IsObject(q);
        s->queue_pos = cJSON_IsNumber(pos) ? pos->valueint : 0;
        s->queue_size = cJSON_IsNumber(size) ? size->valueint : 0;
        s->queue_vm = s->queued && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(q, "voicemail"));
        s->queue_cb = s->queued && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(q, "callback"));
      }
      break;
    }
    case PH_INCOMING:
      if (!strcmp(s->call_id, id) && ended) to_idle(s);
      break;
    case PH_INCALL: {
      if (strcmp(s->call_id, id)) break;
      if (ended) {
        const cJSON *merged = cJSON_GetObjectItemCaseSensitive(m, "merged");
        const cJSON *transfer = cJSON_GetObjectItemCaseSensitive(m, "transfer");
        if (cJSON_IsObject(merged)) {
          phone_init(s);
          s->kind = PH_INROOM;
          CPY(s->room_id, str(merged, "roomId"));
        } else if (cJSON_IsObject(transfer)) {
          bool ringing = cJSON_IsTrue(cJSON_GetObjectItem(transfer, "ringing"));
          const char *next = str(transfer, "callId");
          phone_init(s);
          s->kind = ringing ? PH_DIALING : PH_INCALL;
          CPY(s->call_id, next);
        } else {
          const char *note = str(m, "note");
          to_offhook(s, reason ? reason : "hangup");
          CPY(s->held, held);
          s->lost = note && !strcmp(note, PHONE_LOST_NOTE);
        }
      } else if (!strcmp(state, "active")) {
        const char *hold = str(m, "hold");
        s->connected = true;
        s->held_by_them = hold && !strcmp(hold, "them");
        if (cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(m, "recording"))) s->recorded = true;
      }
      break;
    }
    default:
      break;
  }
  return true;
}

int phone_action_digit(phone_action_t a) {
  switch (a) {
    case ACT_TRANSFER: return 2;
    case ACT_MUTE:
    case ACT_UNMUTE: return 3;
    default: return 1;
  }
}

int phone_actions(const phone_state_t *s, phone_action_t out[3]) {
  if (s->kind == PH_INCALL && s->connected) {
    phone_action_t mute = s->muted ? ACT_UNMUTE : ACT_MUTE;
    if (s->held[0]) {
      out[0] = ACT_MERGE;
      out[1] = ACT_TRANSFER;
      out[2] = mute;
      return 3;
    }
    if (s->held_by_them) {
      out[0] = mute;
      return 1;
    }
    out[0] = ACT_HOLD;
    out[1] = ACT_TRANSFER;
    out[2] = mute;
    return 3;
  }
  if (s->kind == PH_OFFHOOK && s->held[0]) {
    out[0] = ACT_RESUME;
    return 1;
  }
  if (s->kind == PH_INROOM && s->room_id[0]) {
    out[0] = s->muted ? ACT_UNMUTE : ACT_MUTE;
    return 1;
  }
  return 0;
}

const char *phone_action_name(phone_action_t a) {
  static const char *names[] = {"hold", "resume", "merge", "transfer", "mute", "unmute"};
  return names[a];
}

static void emit_hold(phone_emit_fn emit, const char *call_id, bool hold) {
  cJSON *m = msg("call.hold");
  cJSON_AddStringToObject(m, "callId", call_id);
  cJSON_AddBoolToObject(m, "hold", hold);
  emit(m);
}

void phone_action(phone_state_t *s, phone_action_t a, phone_emit_fn emit) {
  phone_action_t offered[3];
  int n = phone_actions(s, offered);
  bool ok = false;
  for (int i = 0; i < n; i++) ok |= offered[i] == a;
  if (!ok) return;
  char id[65];
  switch (a) {
    case ACT_HOLD:
      CPY(id, s->call_id);
      emit_hold(emit, id, true);
      to_offhook(s, "");
      CPY(s->held, id);
      break;
    case ACT_RESUME:
      CPY(id, s->held);
      emit_hold(emit, id, false);
      phone_init(s);
      s->kind = PH_INCALL;
      s->connected = true;
      CPY(s->call_id, id);
      break;
    case ACT_MERGE: {
      cJSON *m = msg("call.merge");
      cJSON_AddStringToObject(m, "callId", s->held);
      cJSON_AddStringToObject(m, "with", s->call_id);
      emit(m);
      phone_init(s);
      s->kind = PH_INROOM;
      break;
    }
    case ACT_TRANSFER:
      if (s->held[0]) {  // with a consult call: connect the two others (attended)
        cJSON *m = msg("call.transfer");
        cJSON_AddStringToObject(m, "callId", s->held);
        cJSON_AddStringToObject(m, "toCall", s->call_id);
        emit(m);
      } else {
        s->transfer_pending = true;  // blind: the next key picks who
      }
      break;
    case ACT_MUTE:
    case ACT_UNMUTE: {
      s->muted = a == ACT_MUTE;
      if (s->kind == PH_INCALL) break;  // a call's mic is the phone's own: nobody else is told
      cJSON *m = msg("room.mute");
      cJSON_AddStringToObject(m, "roomId", s->room_id);
      cJSON_AddBoolToObject(m, "muted", s->muted);
      emit(m);
      break;
    }
  }
}
