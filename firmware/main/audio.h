// The audio task: every 20 ms it reads the mic (only in a call), sends it to the call, and plays
// the call's audio, a call-progress tone, or both, to the earpiece at the chosen volume (capped).
// Also the bring-up modes: a tone, and a mic → earpiece loopback with a delay (an echo test).
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "dsp.h"

#define VOLUME_MAX 10
#define VOLUME_DEFAULT 6

/** Sends one 20 ms mu-law frame to the call (set by rtc.c). */
typedef void (*audio_sender_t)(const uint8_t *ulaw, size_t n, uint32_t pts_ms);

/** Picks the device (ES8311 if found, else the test device) and starts the task. */
void audio_start(bool force_test_device);
const char *audio_device_name(void);

/** The handset is up: the earpiece plays (tones, the call). Down: muted. */
void audio_set_offhook(bool up);
void audio_set_tone(tone_t tone);
/** Call media on/off: the mic is captured and sent only while on. */
void audio_call(bool on, audio_sender_t sender);
/** A received mu-law frame (any length) from the call. Safe from any task. */
void audio_rx_ulaw(const uint8_t *data, size_t n);

/** Volume 0-10 (saved); 10 = the cap (Kconfig OLP_EARPIECE_MAX_DB), 3 dB per step. */
void audio_set_volume(int level);
int audio_volume(void);
float audio_volume_db(int level);

/** Bring-up: play `tone` to the earpiece even on the hook (TONE_NONE = back to normal). */
void audio_force_tone(tone_t tone);
/** Bring-up: mic → earpiece after `delay_ms` (0 = off). Works on the hook too. */
void audio_loopback(int delay_ms);

typedef struct {
  uint32_t tx_frames, rx_frames, rx_bytes, underruns, drops;
  float mic_dbfs;       // last second of mic audio
  float rx_dbfs;        // last second of received (decoded) audio
  float rx_tone_dbfs;   // received audio at the watched frequency
  float watch_hz;
  bool in_call;
} audio_stats_t;
audio_stats_t audio_stats(void);
/** Which frequency to watch for in the received audio (default 440 Hz: the e2e's test tone). */
void audio_watch(float hz);
void audio_print_status(void);
