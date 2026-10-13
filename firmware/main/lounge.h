// A Lounge phone (docs/phone-ux.md, apps/device-web/src/lounge.ts): a shared phone anyone in the
// space takes over by scanning its code and pressing the key the screen names (the proof they're
// standing at it). While someone uses it, it's theirs (their keys, "HI ANA"); when the session
// ends it forgets them. Pure, host-tested; main.c does the messages and the drawing.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#define LOUNGE_REFRESH_LEAD_MS 5000  // ask for a new code this long before the old one expires
#define LOUNGE_NOTE_MS 4000

typedef struct {
  bool on;                  // config.owner.mode == "lounge"
  char nonce[65];           // the takeover code ("" = none)
  int64_t nonce_until;      // when it expires (this phone's clock, ms)
  int challenge;            // the key to press (button index), -1 = none
  int64_t challenge_until;
  bool session;             // someone is using it
  char name[25];
  bool open_to_chat;
  bool house_line;          // nobody signed in, but the space's house-line keys work
  char here[25];            // nobody signed in: someone open to chat at another Lounge phone
  int64_t last_refresh;     // when it last asked for a code
  char note[2][25];         // a short message after a session ends
  int64_t note_until;
} lounge_t;

void lounge_init(lounge_t *l);
void lounge_idle(lounge_t *l, const char *nonce, int64_t until_ms);
void lounge_challenge(lounge_t *l, int index, int64_t until_ms);
void lounge_session(lounge_t *l, const char *name, bool open_to_chat);
/** The session is over: forget the person (and say so for a moment). */
void lounge_ended(lounge_t *l, const char *reason, int64_t now_ms);
void lounge_tick(lounge_t *l, int64_t now_ms);
/** Status lines (≤ 2) for a Lounge phone, or 0 to use the normal status. `idle`: handset down
 * and no call; `offhook`: handset up and nothing dialled. */
int lounge_lines(const lounge_t *l, bool idle, bool offhook, char out[2][41], int64_t now_ms);
/** The QR code shows while the phone is idle with a valid code and nothing else on screen. */
bool lounge_show_qr(const lounge_t *l, bool idle, bool menu_open, int64_t now_ms);
/** Send `lounge.refresh` now (the code is on screen and missing or about to expire). */
bool lounge_wants_refresh(lounge_t *l, bool idle, bool menu_open, int64_t now_ms);
/** Digit keys dial: someone is signed in, or the space gave idle phones house-line keys. */
bool lounge_keys_live(const lounge_t *l);
