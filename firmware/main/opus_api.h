// The part of libopus's public API (opus.h, BSD-licensed, stable since 1.0) the phone uses. On the
// phone libopus comes inside Espressif's esp_audio_codec (which ships no opus.h); the host tests
// link the system's libopus. The request numbers are libopus's own (opus_defines.h).
#pragma once
#include <stdint.h>

typedef struct OpusEncoder OpusEncoder;
typedef struct OpusDecoder OpusDecoder;

#define OPUS_OK 0
#define OPUS_APPLICATION_VOIP 2048
#define OPUS_SET_BITRATE_REQUEST 4002
#define OPUS_SET_MAX_BANDWIDTH_REQUEST 4004
#define OPUS_SET_VBR_REQUEST 4006
#define OPUS_SET_COMPLEXITY_REQUEST 4010
#define OPUS_SET_INBAND_FEC_REQUEST 4012
#define OPUS_SET_PACKET_LOSS_PERC_REQUEST 4014
#define OPUS_SET_DTX_REQUEST 4016
#define OPUS_SET_SIGNAL_REQUEST 4024
#define OPUS_SIGNAL_VOICE 3001
#define OPUS_BANDWIDTH_WIDEBAND 1103

int opus_encoder_get_size(int channels);
int opus_encoder_init(OpusEncoder *st, int32_t fs, int channels, int application);
int opus_encode(OpusEncoder *st, const int16_t *pcm, int frame_size, unsigned char *data,
                int32_t max_data_bytes);
int opus_encoder_ctl(OpusEncoder *st, int request, ...);
int opus_decoder_get_size(int channels);
int opus_decoder_init(OpusDecoder *st, int32_t fs, int channels);
int opus_decode(OpusDecoder *st, const unsigned char *data, int32_t len, int16_t *pcm,
                int frame_size, int decode_fec);
