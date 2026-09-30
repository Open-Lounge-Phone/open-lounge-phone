// A C mirror of `deviceStep` (packages/core/src/device.ts): the handset state machine every
// Open Lounge Phone runs. v0 covers hook, keys, incoming/outgoing calls, rooms and the voicemail
// offer; hold / merge / transfer (MENU during a call) are TODO.
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
  PH_VOICEMAIL,  // our call wasn't answered; voicemail offered (v0: no recording)
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
} phone_state_t;

/** Messages the step produces are passed here (the caller sends and frees them). */
typedef void (*phone_emit_fn)(cJSON *msg);

void phone_init(phone_state_t *s);
void phone_hook(phone_state_t *s, bool up, phone_emit_fn emit);
void phone_button(phone_state_t *s, int index, phone_emit_fn emit);
/** call.ringing / call.state / room.state / room.ended. Returns false for other messages. */
bool phone_server(phone_state_t *s, const cJSON *msg, phone_emit_fn emit);
const char *phone_kind_name(phone_kind_t k);
