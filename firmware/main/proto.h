#pragma once
#include <stdbool.h>
#include "cJSON.h"

#define PROTOCOL_VERSION 1
#define MAX_MESSAGE_BYTES 16384

/** Serialize, log and send one message, then free it. Returns false if not sent. */
bool proto_send(cJSON *msg);
/** Keep-alive, byte for byte as the protocol asks (hibernating servers answer it unwoken). */
bool proto_ping(void);

/**
 * v0 has no call audio: it still completes the WebRTC signaling (so calls go `active`) with an
 * SDP whose audio sections are rejected (port 0, inactive): the peer sends and expects no media.
 * TODO: real media with esp-webrtc.
 */
bool proto_sdp_offer(const char *call_id);
bool proto_sdp_answer(const char *call_id, const char *offer_sdp);
