// The call's voice codec, both ways, on the 16 kHz audio path (docs/audio.md item 2): Opus
// wideband (16 kHz mono, 20 ms, about 24 kbit/s, in-band FEC, complexity 5) or G.711 PCMU at
// 8 kHz through the 2:1 resamplers, for a peer without Opus (and the house intercom). Receiving
// conceals lost frames: Opus with its own concealment, or from the next packet's FEC; PCMU with
// plc.c. Pure C (libopus's API only), host-tested.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "opus_api.h"
#include "plc.h"
#include "resample.h"

#define VOICE_RATE 16000
#define VOICE_FRAME 320          // 20 ms at 16 kHz
#define VOICE_MAX_PACKET 400
#define VOICE_OPUS_BITRATE 24000
// 1, not 5: on a board, complexity 5 (SILK's delayed-decision search) took 13 ms on average and
// up to 24 ms per 20 ms frame (choppy audio, the task watchdog fired); 1 is about 3x cheaper.
#define VOICE_OPUS_COMPLEXITY 1

typedef enum { VOICE_PCMU, VOICE_OPUS } voice_codec_t;

typedef struct {
  voice_codec_t codec;
  OpusEncoder *opus;  // VOICE_OPUS: allocated by voice_tx_open
  rs_t down;
} voice_tx_t;

typedef struct {
  voice_codec_t codec;
  OpusDecoder *opus;
  rs_t up;
  plc_t plc;  // PCMU, at 8 kHz
  uint32_t fec_frames, concealed_frames;
} voice_rx_t;

/** Memory for the Opus states (the phone: internal RAM first). Defined weak; the host uses malloc. */
void *voice_alloc(size_t size);
void voice_free(void *p);

const char *voice_codec_name(voice_codec_t c);
/** Returns false (and falls back to PCMU) if Opus can't be set up. */
bool voice_tx_open(voice_tx_t *tx, voice_codec_t codec);
void voice_tx_close(voice_tx_t *tx);
/** One 20 ms frame at 16 kHz in; the packet's bytes out (0 on error). */
size_t voice_encode(voice_tx_t *tx, const int16_t *pcm, uint8_t *out, size_t cap);

bool voice_rx_open(voice_rx_t *rx, voice_codec_t codec);
void voice_rx_close(voice_rx_t *rx);
/** A packet → 20 ms at 16 kHz. */
void voice_decode(voice_rx_t *rx, const uint8_t *pkt, size_t len, int16_t *out);
/** A lost frame → 20 ms at 16 kHz: from `next`'s FEC when given (Opus), else concealed. */
void voice_conceal(voice_rx_t *rx, const uint8_t *next, size_t next_len, int16_t *out);
