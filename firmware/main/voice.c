#include "voice.h"

#include <stdlib.h>
#include <string.h>

#include "dsp.h"

__attribute__((weak)) void *voice_alloc(size_t size) { return malloc(size); }
__attribute__((weak)) void voice_free(void *p) { free(p); }

const char *voice_codec_name(voice_codec_t c) { return c == VOICE_OPUS ? "opus" : "pcmu"; }

bool voice_tx_open(voice_tx_t *tx, voice_codec_t codec) {
  memset(tx, 0, sizeof *tx);
  rs_init(&tx->down);
  tx->codec = VOICE_PCMU;
  if (codec != VOICE_OPUS) return true;
  OpusEncoder *e = voice_alloc((size_t)opus_encoder_get_size(1));
  if (!e) return false;
  if (opus_encoder_init(e, VOICE_RATE, 1, OPUS_APPLICATION_VOIP) != OPUS_OK) {
    voice_free(e);
    return false;
  }
  opus_encoder_ctl(e, OPUS_SET_BITRATE_REQUEST, (int32_t)VOICE_OPUS_BITRATE);
  opus_encoder_ctl(e, OPUS_SET_COMPLEXITY_REQUEST, (int32_t)VOICE_OPUS_COMPLEXITY);
  opus_encoder_ctl(e, OPUS_SET_SIGNAL_REQUEST, (int32_t)OPUS_SIGNAL_VOICE);
  opus_encoder_ctl(e, OPUS_SET_MAX_BANDWIDTH_REQUEST, (int32_t)OPUS_BANDWIDTH_WIDEBAND);
  // In-band FEC: each packet also carries a coarse copy of the one before (a single loss is
  // recovered from the next packet). Opus only adds it when told to expect some loss.
  opus_encoder_ctl(e, OPUS_SET_INBAND_FEC_REQUEST, (int32_t)1);
  opus_encoder_ctl(e, OPUS_SET_PACKET_LOSS_PERC_REQUEST, (int32_t)10);
  opus_encoder_ctl(e, OPUS_SET_DTX_REQUEST, (int32_t)0);  // a steady stream keeps the path open
  tx->opus = e;
  tx->codec = VOICE_OPUS;
  return true;
}

void voice_tx_close(voice_tx_t *tx) {
  if (tx->opus) voice_free(tx->opus);
  tx->opus = NULL;
}

size_t voice_encode(voice_tx_t *tx, const int16_t *pcm, uint8_t *out, size_t cap) {
  if (tx->codec == VOICE_OPUS && tx->opus) {
    int n = opus_encode(tx->opus, pcm, VOICE_FRAME, out, (int32_t)cap);
    return n > 0 ? (size_t)n : 0;
  }
  int16_t nb[VOICE_FRAME / 2];
  size_t m = rs_down(&tx->down, pcm, VOICE_FRAME, nb);
  if (m > cap) m = cap;
  dsp_ulaw_encode_buf(nb, out, m);
  return m;
}

bool voice_rx_open(voice_rx_t *rx, voice_codec_t codec) {
  memset(rx, 0, sizeof *rx);
  rs_init(&rx->up);
  plc_init(&rx->plc, VOICE_RATE / 2);
  rx->codec = VOICE_PCMU;
  if (codec != VOICE_OPUS) return true;
  OpusDecoder *d = voice_alloc((size_t)opus_decoder_get_size(1));
  if (!d) return false;
  if (opus_decoder_init(d, VOICE_RATE, 1) != OPUS_OK) {
    voice_free(d);
    return false;
  }
  rx->opus = d;
  rx->codec = VOICE_OPUS;
  return true;
}

void voice_rx_close(voice_rx_t *rx) {
  if (rx->opus) voice_free(rx->opus);
  rx->opus = NULL;
}

static void pcmu_out(voice_rx_t *rx, const int16_t *nb, int16_t *out) {
  rs_up(&rx->up, nb, VOICE_FRAME / 2, out);
}

void voice_decode(voice_rx_t *rx, const uint8_t *pkt, size_t len, int16_t *out) {
  if (rx->codec == VOICE_OPUS && rx->opus) {
    int n = opus_decode(rx->opus, pkt, (int32_t)len, out, VOICE_FRAME, 0);
    if (n < VOICE_FRAME) memset(out + (n > 0 ? n : 0), 0, (size_t)(VOICE_FRAME - (n > 0 ? n : 0)) * 2);
    return;
  }
  int16_t nb[VOICE_FRAME / 2] = {0}, smooth[VOICE_FRAME / 2];
  dsp_ulaw_decode_buf(pkt, nb, len < VOICE_FRAME / 2 ? len : VOICE_FRAME / 2);
  plc_good(&rx->plc, nb, smooth, VOICE_FRAME / 2);
  pcmu_out(rx, smooth, out);
}

void voice_conceal(voice_rx_t *rx, const uint8_t *next, size_t next_len, int16_t *out) {
  rx->concealed_frames++;
  if (rx->codec == VOICE_OPUS && rx->opus) {
    int n;
    if (next && next_len) {
      n = opus_decode(rx->opus, next, (int32_t)next_len, out, VOICE_FRAME, 1);  // its FEC copy
      if (n == VOICE_FRAME) {
        rx->fec_frames++;
        return;
      }
    }
    n = opus_decode(rx->opus, NULL, 0, out, VOICE_FRAME, 0);  // Opus's own concealment
    if (n < VOICE_FRAME) memset(out + (n > 0 ? n : 0), 0, (size_t)(VOICE_FRAME - (n > 0 ? n : 0)) * 2);
    return;
  }
  int16_t nb[VOICE_FRAME / 2];
  plc_lost(&rx->plc, nb, VOICE_FRAME / 2);
  pcmu_out(rx, nb, out);
}
