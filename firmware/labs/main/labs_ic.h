// The house intercom (labs): phones on one Wi-Fi find each other and call room to room with no
// server. Every message is a UDP broadcast line "OLP1|<TYPE>|..." that every phone hears:
//   HELLO|room                      who is here (every 20 s; peers drop after 90 s silent)
//   RING|id|to|from|kind            to = a room or "*" (all); kind = call | door
//   ANSWER|id|from                  the first to lift; the others stop ringing
//   BUSY|id|from   BYE|id|from      refused / hung up
//   CHIME|from|text                 "DINNER'S READY" on every phone (a beep, no call)
// Audio goes straight to the other phone (glue: G.711 u-law, 20 ms frames over UDP).
// Pure: the glue sends the lines in `out`, and rings / starts audio from the state.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#define IC_LINE 128
#define IC_OUT 4
#define IC_PEERS 12
#define IC_RING_MS 30000
#define IC_PEER_MS 90000
#define IC_NOTE_MS 4000

typedef enum { IC_IDLE, IC_CALLING, IC_RINGING, IC_TALK } ic_state_t;

typedef struct {
  char name[25];
  uint32_t ip;
  int64_t seen;
} ic_peer_t;

typedef struct {
  char me[25];
  ic_state_t st;
  uint32_t id;
  char peer[25];       // the other room (or "ALL ROOMS" while ringing them)
  uint32_t peer_ip;    // where audio goes (known once answered / on ringing)
  bool door;           // a doorbell call
  bool to_all;
  int64_t since;
  ic_peer_t peers[IC_PEERS];
  char note[2][41];    // "BUSY", "NO ANSWER", a chime's words
  int64_t note_until;
  bool chimed;         // a chime just arrived (the glue beeps, then clears it)
} ic_t;

typedef struct {
  char lines[IC_OUT][IC_LINE];
  int n;
} ic_out_t;

void icom_init(ic_t *ic, const char *me);
void icom_hello(const ic_t *ic, ic_out_t *out);
/** Call a room ("*" = every room). A doorbell rings even with the handset down. */
bool icom_call(ic_t *ic, const char *to, bool door, uint32_t id, int64_t now, ic_out_t *out);
void icom_chime(const ic_t *ic, const char *text, ic_out_t *out);
void icom_hook(ic_t *ic, bool up, int64_t now, ic_out_t *out);
/** BACK: stop calling / ringing out / talking (a doorbell's only way out, handset down). */
void icom_cancel(ic_t *ic, ic_out_t *out);
/** A line from `ip`. */
void icom_msg(ic_t *ic, uint32_t ip, const char *line, int64_t now, ic_out_t *out);
void icom_tick(ic_t *ic, int64_t now, ic_out_t *out);
/** Peers heard in the last IC_PEER_MS. */
int icom_peer_count(const ic_t *ic, int64_t now);
/** Status lines (0 when idle and nothing to say). */
int icom_lines(const ic_t *ic, int64_t now, char out[2][41]);
