// The server's note when a Lounge phone with nobody signed in calls a public line (core
// `SIGN_IN_FOR_LINES_NOTE`): the phone shows SIGN IN TO CALL.
#define PHONE_SIGN_IN_NOTE "Sign in at this phone to call a public line"
// The server's note when a call's audio connection was lost (core `CONNECTION_LOST_NOTE`): the
// phone shows CONNECTION LOST.
#define PHONE_LOST_NOTE "The connection was lost"

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
  int button;          // dialing: the key as stored, (page - 1) * 10 + slot (-1 = not a key)
  int page;            // offhook: the page of speed-dial keys on screen (0 or 1 = page 1)
  char call_id[65];    // dialing (may be ""), incoming, incall
  char from[25];       // incoming: caller label; voicemail: the offer's name
  bool connected;      // incall
  bool held_by_them;   // incall
  char room_id[65];    // inroom ("" while joining)
  bool muted;          // incall: MENU 3 (local: the mic sends silence); inroom: room.mute
  bool recorded;       // incall / inroom: announced as recorded (status LED + REC)
  char vm_ticket[129];  // voicemail: the offer's single-use ticket
  int vm_max_ms;       // voicemail: the longest message accepted
  char held[65];       // offhook / dialing / incall: a call this phone put on hold ("" = none)
  bool transfer_pending;  // incall: the next key transfers the call to that key's person
  // dialing: waiting in a public line's queue (call.state.queue): the place in line (0 = not
  // shown), how many wait, whether key 1 leaves a voicemail instead, and whether key 2 asks
  // the line to call back.
  bool queued;
  int queue_pos;
  int queue_size;
  bool queue_vm;
  bool queue_cb;
  // offhook: you just asked a line to call you back (your place is kept); incoming: a line
  // calling you back, as you asked (lift to answer: the call to the line goes on).
  bool callback;
  // offhook: a Lounge phone with nobody signed in tried a public line (SIGN IN TO CALL).
  bool sign_in;
  // offhook: why the last call didn't go through, when the server's note is one the phone has
  // words for (core refusals.ts; phone_why_text): 0 = none.
  int why;
  // incoming: the caller is an add-on (call.ringing from.kind "addon"): shown "SEAT - ADD-ON".
  bool addon;
  // offhook: the last call's audio connection dropped and couldn't be restored (CONNECTION LOST).
  bool lost;
  // incoming: BACK stopped the ringer on this phone (lifting still answers).
  bool silenced;
  // incall: call waiting, another call ringing softly (call.ringing waiting): 1 takes it, 2
  // ignores it. One call has audio at a time on this phone, so taking it ends this call.
  char waiting_id[65];
  char waiting_from[25];
  bool waiting_addon;
} phone_state_t;

/**
 * The phone's words for a refusal note (core `refusalStatus`, first line; the second is PRESS A
 * KEY): phone_why(note) gives its number (0 = no words for it), phone_why_text(n) the line.
 */
int phone_why(const char *note);
const char *phone_why_text(int why);

/** What MENU offers in a call or a room (core `CallAction`). */
typedef enum { ACT_HOLD, ACT_RESUME, ACT_MERGE, ACT_TRANSFER, ACT_MUTE, ACT_UNMUTE } phone_action_t;

/** Messages the step produces are passed here (the caller sends and frees them). */
typedef void (*phone_emit_fn)(cJSON *msg);

void phone_init(phone_state_t *s);
void phone_hook(phone_state_t *s, bool up, phone_emit_fn emit);
void phone_button(phone_state_t *s, int index, phone_emit_fn emit);
/** A digit key (its slot, 0-9) on `page` (core input `button` with `page`: Redial); 0 = the
 * page on screen. Handset up and nothing dialled; elsewhere it is phone_button. */
void phone_key(phone_state_t *s, int slot, int page, phone_emit_fn emit);
/** BACK on the speed-dial screen (core input `page`): the next of `pages` (the pages shown,
 * strip_key_pages), wrapping to the first. Nothing with one page or off that screen. */
void phone_page(phone_state_t *s, const int *pages, int n);
/** In a call, MENU → 6: hand the call to an extension (blind transfer). */
void phone_transfer_extension(phone_state_t *s, const char *number, phone_emit_fn emit);
/** MENU → 6: dial an extension (team and organization spaces). Handset up, nothing dialled. */
void phone_extension(phone_state_t *s, const char *number, phone_emit_fn emit);
/** MENU → 5 → 1: call a missed caller back (`call.back`, a `config.missed` id). Handset up,
 * nothing dialled (core input `callBack`). */
void phone_call_back(phone_state_t *s, const char *id, phone_emit_fn emit);
/** The phone ends its call itself (e.g. the media failed): hang up, stay off the hook. */
void phone_hangup(phone_state_t *s, const char *reason, phone_emit_fn emit);
/** BACK while ringing (core input `silence`): the ringer stops here; the call goes on ringing
 * elsewhere and lifting still answers. */
void phone_silence(phone_state_t *s);

/** The last few calls that ended here (core `repeatedEnd`). */
typedef struct {
  char ids[4][65];
} phone_ends_t;
/** A `call.state ended` for a call that already ended here (a server repeating itself): true =
 * drop it, so it can't end the next call. Otherwise remembers an ended call's id. */
bool phone_repeated_end(phone_ends_t *t, const cJSON *msg);

/** The call's audio connection dropped and didn't come back (core input `lost`): hang up with
 * `lost`, so the other side is told why, and show CONNECTION LOST. */
void phone_lost(phone_state_t *s, phone_emit_fn emit);
/** call.ringing / call.state / room.state / room.ended. Returns false for other messages. */
bool phone_server(phone_state_t *s, const cJSON *msg, phone_emit_fn emit);
const char *phone_kind_name(phone_kind_t k);
/** The actions MENU offers now (core `callActions`), in order; returns how many (≤ 3). */
int phone_actions(const phone_state_t *s, phone_action_t out[3]);
/** The digit an action has on the call screen (core `callActionDigit`): 1 hold / resume /
 * merge, 2 transfer, 3 mute / unmute. */
int phone_action_digit(phone_action_t a);
/** Do one (ignored unless phone_actions offers it). */
void phone_action(phone_state_t *s, phone_action_t a, phone_emit_fn emit);
const char *phone_action_name(phone_action_t a);
