// The self-test (MENU → 7 → 1, docs/phone-ux.md): a picture of the keypad where each key fills in
// when pressed, plus the hook (lifted and put back) and the handset jack (plugged and unplugged).
// The earpiece plays a 1 kHz tone and every key clicks the piezo meanwhile (main.c does the
// sound). It ends when every key and the hook have been seen, or after 30 s without input. The
// hook still works as usual meanwhile; an incoming call ends the test.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#define SELFTEST_IDLE_MS 30000
#define SELFTEST_DONE_MS 3000  // "ALL GOOD" stays this long

void selftest_start(int64_t now_ms, bool hook_up, bool jack_in);
bool selftest_active(void);
/** Inputs while active (the self-test takes every key, MENU and BACK included). */
void selftest_key(int index, int64_t now_ms);
void selftest_hook(bool up, int64_t now_ms);
void selftest_jack(bool in, int64_t now_ms);
/** Ends it now (a call is ringing). */
void selftest_stop(void);
/** True when it just ended (finished or timed out). */
bool selftest_tick(int64_t now_ms);
/** All 12 keys and both hook positions seen. */
bool selftest_passed(void);
/** Something changed since the last draw. */
bool selftest_dirty(void);
void selftest_draw(uint8_t *fb, int w, int h);
