// A C mirror of `deviceStep` (packages/core/src/device.ts): the handset state machine every
// Open Lounge Phone runs: hook, keys, incoming/outgoing calls, rooms, the voicemail offer, and the
// call actions MENU offers in a call (hold / add caller, resume, merge, transfer, mute).
#pragma once
#include <stdbool.h>
#include "cJSON.h"

typedef enum {
  PH_IDLE,       // handset on the cradle
  PH_OFFHOOK,    // handset up, waiting for a key
  PH_DIALING,    // placed a call, not yet answered
  PH_INCOMING,   // ringing, handset down
  PH_INCALL,
  PH_INROOM,
  PH_VOICEMAIL,  // our call wasn't answered; voicemail offered (leave a message: vmleave.c)
} phone_kind_t;

typedef struct {
  phone_kind_t kind;
  char last_end[16];   // offhook: why the last call ended ("" = none)
  int button;          // dialing: the key (-1 = extension/transfer)
  char call_id[65];    // dialing (may be ""), incoming, incall
  char from[25];       // incoming: caller label; voicemail: the offer's name
  bool connected;      // incall
  bool held_by_them;   // incall
  char room_id[65];    // inroom ("" while joining)
  bool muted;          // inroom
  bool recorded;       // incall / inroom: announced as recorded (status LED + REC)
  char vm_ticket[129];  // voicemail: the offer's single-use ticket
  int vm_max_ms;       // voicemail: the longest message accepted
  char held[65];       // offhook / dialing / incall: a call this phone put on hold ("" = none)
  bool transfer_pending;  // incall: the next key transfers the call to that key's person
  // dialing: waiting in a public line's queue (call.state.queue): the place in line (0 = not
  // shown), how many wait, and whether key 1 leaves a voicemail instead.
  bool queued;
  int queue_pos;
  int queue_size;
  bool queue_vm;
} phone_state_t;

/** What MENU offers in a call or a room (core `CallAction`). */
typedef enum { ACT_HOLD, ACT_RESUME, ACT_MERGE, ACT_TRANSFER, ACT_MUTE, ACT_UNMUTE } phone_action_t;

/** Messages the step produces are passed here (the caller sends and frees them). */
typedef void (*phone_emit_fn)(cJSON *msg);

void phone_init(phone_state_t *s);
void phone_hook(phone_state_t *s, bool up, phone_emit_fn emit);
void phone_button(phone_state_t *s, int index, phone_emit_fn emit);
/** In a call, MENU → 6: hand the call to an extension (blind transfer). */
void phone_transfer_extension(phone_state_t *s, const char *number, phone_emit_fn emit);
/** MENU → 6: dial an extension (team and organization spaces). Handset up, nothing dialled. */
void phone_extension(phone_state_t *s, const char *number, phone_emit_fn emit);
/** The phone ends its call itself (e.g. the media failed): hang up, stay off the hook. */
void phone_hangup(phone_state_t *s, const char *reason, phone_emit_fn emit);
/** call.ringing / call.state / room.state / room.ended. Returns false for other messages. */
bool phone_server(phone_state_t *s, const cJSON *msg, phone_emit_fn emit);
const char *phone_kind_name(phone_kind_t k);
/** The actions MENU offers now (core `callActions`), in order; returns how many (≤ 2). */
int phone_actions(const phone_state_t *s, phone_action_t out[2]);
/** Do one (ignored unless phone_actions offers it). */
void phone_action(phone_state_t *s, phone_action_t a, phone_emit_fn emit);
const char *phone_action_name(phone_action_t a);
