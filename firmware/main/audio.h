// The audio task: every 20 ms it reads the mic (only in a call), sends it to the call, and plays
// the call's audio, a call-progress tone, or both, to the earpiece at the chosen volume (capped).
// Also the bring-up modes: a tone, and a mic → earpiece loopback with a delay (an echo test).
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "dsp.h"
#include "echo.h"
#include "voice.h"

#define VOLUME_MAX 10
#define VOLUME_DEFAULT 6

/** Sends one 20 ms packet (Opus or mu-law, the call's codec) to the call. */
typedef void (*audio_sender_t)(const uint8_t *data, size_t n, uint32_t pts_ms);

/** Picks the device (ES8311 if found, else the test device) and starts the task. */
void audio_start(bool force_test_device);
const char *audio_device_name(void);

/** The handset is up: the earpiece plays (tones, the call). Down: muted. */
void audio_set_offhook(bool up);
void audio_set_tone(tone_t tone);
/** Call media on/off: the mic is captured and sent only while on, coded as `codec` (and the
 * call's packets are taken to be that too, until audio_rx_codec says otherwise). */
void audio_call(bool on, voice_codec_t codec, audio_sender_t sender);
/** The codec of what the other side sends (it may differ from ours). */
void audio_rx_codec(voice_codec_t codec);
/**
 * Leaving a voicemail: the mic records 8 kHz 16-bit samples (resampled from the 16 kHz path) into `buf` (at most `max_samples`;
 * the mic is on only meanwhile). audio_record_stop ends it and says how many samples it took.
 */
void audio_record(int16_t *buf, size_t max_samples);
size_t audio_recorded(void);
size_t audio_record_stop(void);
/**
 * Playing a voicemail: 8 kHz 16-bit samples to the earpiece (the buffer must stay alive until
 * audio_play(NULL, 0)). audio_played() says how far it got (== count: finished).
 */
void audio_play(const int16_t *samples, size_t count);
size_t audio_played(void);
/** This phone put the call on hold: the mic is off and silence is sent; nothing plays. */
void audio_hold(bool held);
/** MENU 3 in a call: the mic is muted (silence is sent); the other side is still heard. */
void audio_mute(bool muted);
/** The phone check (MENU 7) with the handset up: the mic is on only to measure its level
 * (audio_stats mic_dbfs / mic_peak_dbfs); nothing is sent or kept. */
void audio_listen(bool on);
/** The mic's automatic gain control (on by default: CONFIG_OLP_MIC_AGC); `audio agc`. */
void audio_agc(bool on);
bool audio_agc_on(void);
/** A received packet of the call (20 ms of mu-law) with its timestamp in ms; any order. Goes
 * into the jitter buffer (jbuf.h). Safe from any task. */
void audio_rx_packet(const uint8_t *data, size_t n, uint32_t pts_ms);

/** Volume 0-10 (saved); 10 = the cap (Kconfig OLP_EARPIECE_MAX_DB), 3 dB per step. */
void audio_set_volume(int level);
int audio_volume(void);
float audio_volume_db(int level);

/** Sidetone (MENU 1 6): your own voice in the earpiece in a call, off / low (-26 dB) / normal
 * (-20 dB, the default); never while muted. Saved. */
void audio_set_sidetone(sidetone_t level);
sidetone_t audio_sidetone(void);
const char *sidetone_name(sidetone_t level);
/** The sidetone path's delay, mic to earpiece, as built (ms). */
float audio_sidetone_latency_ms(void);
/** The echo test measured that path over 5 ms: the sidetone stays off. */
bool audio_sidetone_slow(void);

/** The echo canceller (MENU 1 7), from the next call; saved. Default CONFIG_OLP_ECHO_CANCEL;
 * the echo test turns it on when the echo is poor. */
void audio_set_echo_cancel(bool on);
bool audio_echo_cancel(void);
/** The phone check's echo test (MENU 7 2, handset up, not in a call): a 2 s sweep in the
 * earpiece, the mic measured. False if it can't start now. */
bool audio_echo_test(void);
/** 0 never run, 1-2 running, 3 done (`r` filled). */
int audio_echo_test_state(echo_result_t *r);

/** Bring-up: play `tone` to the earpiece even on the hook (TONE_NONE = back to normal). */
void audio_force_tone(tone_t tone);
/** Bring-up: mic → earpiece after `delay_ms` (0 = off). Works on the hook too. */
void audio_loopback(int delay_ms);

typedef struct {
  uint32_t tx_frames, rx_frames, rx_bytes;
  // The receive buffer (jbuf.h): buffered up again, frames dropped (too deep), concealed (lost
  // or missing: the poor-connection signal), arrived too late; its target depth and the jitter.
  uint32_t underruns, drops, concealed, late;
  int jb_target_ms;
  float jitter_ms;
  float mic_dbfs;       // last second of mic audio
  float mic_peak_dbfs;  // …its loudest sample
  float rx_dbfs;        // last second of received (decoded) audio
  float rx_tone_dbfs;   // received audio at the watched frequency
  float watch_hz;
  bool in_call;
  // The mic's AGC (once a second): its gain, and the speech it heard before and after it.
  float agc_gain_db;
  float speech_in_dbfs, speech_out_dbfs;  // -100 until there was speech
  int64_t speech_ms;                      // when those were last updated (ms since boot)
} audio_stats_t;
audio_stats_t audio_stats(void);
/** Which frequency to watch for in the received audio (default 440 Hz: the e2e's test tone). */
void audio_watch(float hz);
void audio_print_status(void);

/** Saves settings the audio task changed (it can't write flash itself). Main task, often. */
void audio_persist(void);
