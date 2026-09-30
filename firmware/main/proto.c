#include "proto.h"

#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "net.h"

static const char *TAG = "proto";

bool proto_send(cJSON *msg) {
  char *text = cJSON_PrintUnformatted(msg);
  cJSON_Delete(msg);
  if (!text) return false;
  bool ok = false;
  if (strlen(text) > MAX_MESSAGE_BYTES) {
    ESP_LOGE(TAG, "message too large (%u bytes): not sent", (unsigned)strlen(text));
  } else {
    ok = net_ws_send(text);
    ESP_LOGI(TAG, "%s %s", ok ? "->" : "-> (not sent)", text);
  }
  free(text);
  return ok;
}

bool proto_ping(void) { return net_ws_send("{\"t\":\"ping\"}"); }

#include <stdio.h>
#include "esp_random.h"

/** Session part: fresh ICE credentials and a (never used) DTLS fingerprint. */
static int sdp_session(char *out, size_t n, const char *setup) {
  uint8_t r[40];
  esp_fill_random(r, sizeof r);
  int len = snprintf(out, n,
                     "v=0\r\no=- %u 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
                     "a=ice-ufrag:%02x%02x%02x%02x\r\na=ice-pwd:",
                     (unsigned)(r[0] << 16 | r[1] << 8 | r[2]), r[3], r[4], r[5], r[6]);
  for (int i = 0; i < 12; i++) len += snprintf(out + len, n - len, "%02x", r[7 + i]);
  len += snprintf(out + len, n - len, "\r\na=fingerprint:sha-256 ");
  for (int i = 0; i < 32; i++) {
    uint8_t b = i < 21 ? r[19 + i] : (uint8_t)(r[i] ^ 0x5a);
    len += snprintf(out + len, n - len, "%02X%s", b, i < 31 ? ":" : "");
  }
  len += snprintf(out + len, n - len, "\r\na=setup:%s\r\n", setup);
  return len;
}

static int sdp_rejected_audio(char *out, size_t n, const char *kind, const char *proto,
                              const char *pt, const char *mid) {
  return snprintf(out, n,
                  "m=%s 0 %s %s\r\nc=IN IP4 0.0.0.0\r\na=mid:%s\r\na=inactive\r\na=rtcp-mux\r\n"
                  "a=rtpmap:%s opus/48000/2\r\n",
                  kind, proto, pt, mid, pt);
}

static bool send_sdp(const char *call_id, const char *type, const char *sdp) {
  cJSON *m = cJSON_CreateObject();
  cJSON_AddStringToObject(m, "t", "rtc.sdp");
  cJSON_AddStringToObject(m, "callId", call_id);
  cJSON_AddStringToObject(m, "type", type);
  cJSON_AddStringToObject(m, "sdp", sdp);
  return proto_send(m);
}

bool proto_sdp_offer(const char *call_id) {
  char sdp[768];
  int len = sdp_session(sdp, sizeof sdp, "actpass");
  sdp_rejected_audio(sdp + len, sizeof sdp - len, "audio", "UDP/TLS/RTP/SAVPF", "111", "0");
  return send_sdp(call_id, "offer", sdp);
}

bool proto_sdp_answer(const char *call_id, const char *offer) {
  char *sdp = malloc(2048);
  if (!sdp) return false;
  int len = sdp_session(sdp, 2048, "active");
  // One rejected section per offered m-line, same kind, protocol, first format and mid.
  const char *p = offer;
  while ((p = strstr(p, "m=")) && len < 1900) {
    if (p != offer && p[-1] != '\n') {
      p += 2;
      continue;
    }
    char kind[16] = "", proto[32] = "", pt[8] = "", mid[32] = "0";
    sscanf(p, "m=%15s %*s %31s %7s", kind, proto, pt);
    const char *next = strstr(p + 2, "\nm=");
    const char *a = strstr(p, "a=mid:");
    if (a && (!next || a < next)) sscanf(a, "a=mid:%31s", mid);
    len += sdp_rejected_audio(sdp + len, 2048 - len, kind, proto, pt, mid);
    p += 2;
  }
  bool ok = send_sdp(call_id, "answer", sdp);
  free(sdp);
  return ok;
}
