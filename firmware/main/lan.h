// The house intercom on the phone (docs/phone-ux.md "House intercom"): the sockets, the audio and
// the seals around the intercom's state machine (intercom.c). Off unless the server's config turns
// it on for this phone (`config.intercom`: the room's name and the space's key); the phone keeps
// the key in NVS, so it works while the internet is down, and forgets it when it's turned off.
#pragma once
#include <stdbool.h>
#include <stdint.h>

/** At boot: the saved room and key, if the intercom is on. */
void lan_init(void);
/** From `config` (online, signed in): on with this room and key, or off (NULLs). */
void lan_config(const char *room, const char *key_b64url);
bool lan_enabled(void);
/** Wi-Fi up: the sockets (once). */
void lan_net_up(void);
void lan_tick(int64_t now);
/** EV_LAN from the receive task (frees `data`). */
void lan_event(char *data, int64_t now);
/** The phone is in a call through the server: a ring here is busy. */
void lan_set_engaged(bool engaged);

/** Call a room ("*" = every room). A doorbell (labs) rings even with the handset down. */
bool lan_call(const char *room, bool door, int64_t now);
/** A chime on every phone of the intercom (labs keys). */
void lan_chime(const char *text);
/** The hook: true if the intercom took it (ringing here, or an intercom call). */
bool lan_hook(bool up, int64_t now);
/** BACK: stop calling or talking. True if there was something to stop. */
bool lan_cancel(void);

/** Status lines while the intercom has something to say (0 = nothing). */
int lan_lines(char out[2][41], int64_t now);
bool lan_ringing(void);
/** Calling, ringing or talking. */
bool lan_busy(void);
/** The rooms heard lately (MENU 4), at most `max`. */
int lan_rooms(char names[][25], int max, int64_t now);
