#include "phone.h"

#include <string.h>

static void cpy(char *dst, size_t n, const char *src) {
  if (!src) src = "";
  strncpy(dst, src, n - 1);
  dst[n - 1] = '\0';
}
#define CPY(dst, src) cpy((dst), sizeof(dst), (src))

static cJSON *msg(const char *t) {
  cJSON *m = cJSON_CreateObject();
  cJSON_AddStringToObject(m, "t", t);
  return m;
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
  if (s->kind == PH_INROOM && s->room_id[0]) emit_room_leave(emit, s->room_id);
  emit_hook(emit, false);
  to_idle(s);
}

void phone_button(phone_state_t *s, int index, phone_emit_fn emit) {
  if (s->kind == PH_OFFHOOK) {
    cJSON *m = msg("button");
    cJSON_AddNumberToObject(m, "index", index);
    emit(m);
    phone_init(s);
    s->kind = PH_DIALING;
    s->button = index;
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

static const char *str(const cJSON *o, const char *key) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
  return cJSON_IsString(v) ? v->valuestring : NULL;
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
        (s->kind == PH_DIALING && !s->call_id[0])) {
      phone_init(s);
      s->kind = PH_INROOM;
      CPY(s->room_id, room);
      s->muted = muted;
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
    } else if (!(s->call_id[0] && !strcmp(s->call_id, id))) {
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
  switch (s->kind) {
    case PH_DIALING: {
      if (s->call_id[0] && strcmp(s->call_id, id)) break;
      const cJSON *vm = cJSON_GetObjectItemCaseSensitive(m, "voicemail");
      if (ended && cJSON_IsObject(vm)) {
        phone_init(s);
        s->kind = PH_VOICEMAIL;
        CPY(s->from, str(vm, "name"));
      } else if (ended) {
        to_offhook(s, reason ? reason : "hangup");
      } else if (!strcmp(state, "active") || !strcmp(state, "connecting")) {
        phone_init(s);
        s->kind = PH_INCALL;
        CPY(s->call_id, id);
        s->connected = !strcmp(state, "active");
      } else {
        CPY(s->call_id, id);
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
          to_offhook(s, reason ? reason : "hangup");
        }
      } else if (!strcmp(state, "active")) {
        const char *hold = str(m, "hold");
        s->connected = true;
        s->held_by_them = hold && !strcmp(hold, "them");
      }
      break;
    }
    default:
      break;
  }
  return true;
}
