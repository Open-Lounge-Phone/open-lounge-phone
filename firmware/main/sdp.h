// Small SDP helpers for the call's audio (pure C, host-tested): which codecs a description's
// audio section offers, and our own Opus parameters added to the local description.
#pragma once
#include <stddef.h>

#define SDP_OPUS 1u  // opus/48000/2
#define SDP_PCMU 2u  // PCMU/8000 (static payload type 0)

/** The audio codecs (SDP_OPUS | SDP_PCMU) listed on the m=audio line, by their rtpmap. */
unsigned sdp_audio_codecs(const char *sdp);
/**
 * A copy of `sdp` (malloc'd; NULL on no memory) whose Opus format has our receive parameters:
 * in-band FEC (the other side then sends it), 20 ms frames and a 16 kHz cap (we play 16 kHz:
 * the other side needn't code more). Parameters already there are kept.
 */
char *sdp_with_opus_params(const char *sdp);
