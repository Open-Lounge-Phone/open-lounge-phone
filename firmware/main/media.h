// Call media: one WebRTC peer connection per call with Espressif's esp_peer (ICE with the
// server's STUN/TURN from `rtc.config`, DTLS-SRTP, G.711 mu-law audio). The party that placed the
// call offers; esp_peer puts its own candidates in the SDP, and the other side's trickled
// `rtc.ice` candidates are fed back in. All esp_peer calls but sending audio run on its task.
#pragma once
#include <stdbool.h>
#include "cJSON.h"
#include "ice.h"

void media_init(void);
/** Starts the peer connection for `call_id` with the `iceServers` of its `rtc.config`. */
void media_start(const char *call_id, bool offerer, const cJSON *ice_servers);
/** The other side's SDP (`rtc.sdp`). */
void media_remote_sdp(const char *call_id, const char *sdp);
/** A trickled candidate (`rtc.ice`), the bare `candidate:` string. */
void media_remote_candidate(const char *call_id, const char *candidate);
void media_stop(void);
/** The call this peer connection belongs to ("" = none). */
const char *media_call_id(void);
bool media_active(void);
bool media_connected(void);
void media_set_ice_mode(ice_mode_t mode);
ice_mode_t media_ice_mode(void);
void media_print_status(void);
