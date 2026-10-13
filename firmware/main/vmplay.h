// Listening to voicemail on the phone (docs/phone-ux.md, MENU → 2): `voicemail.fetch` lists the
// owner's unheard messages; each one in WAV is downloaded (`GET /api/vm/play?ticket=`) into
// PSRAM and played to the earpiece, then marked heard (`voicemail.heard`). Messages phones can't
// play (older Opus recordings) say PLAY IN APP. "Clear" marks every message heard unplayed.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "cJSON.h"

typedef void (*vmplay_send_fn)(cJSON *msg);

void vmplay_init(vmplay_send_fn send);
/** MENU → 2 → 1 (play) or 3 (clear). */
void vmplay_start(bool clear, int64_t now_ms);
/** Labs (dial-a-story): play one WAV (8 kHz 16-bit mono) from an http(s) URL, titled. */
void vmplay_play_url(const char *url, const char *title, int64_t now_ms);
/** The server's `voicemail.items`. */
void vmplay_items(const cJSON *msg, int64_t now_ms);
/** The download task finished (EV_VM_LOADED). */
void vmplay_loaded(bool ok, int64_t now_ms);
/** Keys while active: 1 again, 2 next, BACK stop. True if consumed (all keys are, while active). */
bool vmplay_key(int key, int64_t now_ms);
void vmplay_stop(void);
void vmplay_tick(int64_t now_ms);
bool vmplay_active(void);
/** Lines to show (≤ 4 × 20 chars). */
int vmplay_lines(char out[4][25], int64_t now_ms);
