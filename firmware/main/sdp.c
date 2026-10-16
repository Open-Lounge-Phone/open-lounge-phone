#include "sdp.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *OPUS_PARAMS[] = {"minptime=10", "useinbandfec=1", "maxplaybackrate=16000",
                                    "sprop-maxcapturerate=16000"};

/** Payload types listed on the audio m-line ("m=audio 9 UDP/TLS/RTP/SAVPF 111 0"). */
static int audio_pts(const char *sdp, int *pts, int max) {
  const char *m = strstr(sdp, "m=audio ");
  if (!m) return 0;
  const char *end = strpbrk(m, "\r\n");
  if (!end) end = m + strlen(m);
  int n = 0, field = 0;
  for (const char *p = m; p < end && n < max;) {
    while (p < end && *p == ' ') p++;
    const char *q = p;
    while (q < end && *q != ' ') q++;
    if (++field > 3 && q > p && isdigit((unsigned char)*p)) pts[n++] = atoi(p);  // m= port proto PTs
    p = q;
  }
  return n;
}

/** The rtpmap encoding of payload type `pt` ("opus/48000/2"), copied into `out`. */
static int rtpmap(const char *sdp, int pt, char *out, size_t cap) {
  char key[24];
  snprintf(key, sizeof key, "a=rtpmap:%d ", pt);
  const char *a = strstr(sdp, key);
  if (!a) return 0;
  a += strlen(key);
  size_t i = 0;
  while (a[i] && a[i] != '\r' && a[i] != '\n' && i + 1 < cap) {
    out[i] = a[i];
    i++;
  }
  out[i] = '\0';
  return 1;
}

static int opus_pt(const char *sdp) {
  int pts[32];
  int n = audio_pts(sdp, pts, 32);
  char enc[48];
  for (int i = 0; i < n; i++)
    if (rtpmap(sdp, pts[i], enc, sizeof enc) && !strncasecmp(enc, "opus/48000", 10)) return pts[i];
  return -1;
}

unsigned sdp_audio_codecs(const char *sdp) {
  if (!sdp) return 0;
  int pts[32];
  int n = audio_pts(sdp, pts, 32);
  unsigned have = 0;
  char enc[48];
  for (int i = 0; i < n; i++) {
    if (rtpmap(sdp, pts[i], enc, sizeof enc)) {
      if (!strncasecmp(enc, "opus/48000", 10)) have |= SDP_OPUS;
      if (!strncasecmp(enc, "PCMU/8000", 9)) have |= SDP_PCMU;
    } else if (pts[i] == 0) {
      have |= SDP_PCMU;  // static payload type 0 needs no rtpmap
    }
  }
  return have;
}

char *sdp_with_opus_params(const char *sdp) {
  int pt = opus_pt(sdp);
  size_t len = strlen(sdp);
  const char *eol = strstr(sdp, "\r\n") ? "\r\n" : "\n";
  char *out = malloc(len + 160);
  if (!out) return NULL;
  if (pt < 0) {
    memcpy(out, sdp, len + 1);
    return out;
  }
  char key[24];
  snprintf(key, sizeof key, "a=fmtp:%d ", pt);
  const char *f = strstr(sdp, key);
  if (f) {
    // Add the parameters the line doesn't have.
    const char *fe = strpbrk(f, "\r\n");
    if (!fe) fe = sdp + len;
    size_t at = (size_t)(fe - sdp);
    memcpy(out, sdp, at);
    out[at] = '\0';
    for (size_t i = 0; i < sizeof OPUS_PARAMS / sizeof OPUS_PARAMS[0]; i++) {
      char name[32];
      snprintf(name, sizeof name, "%.*s", (int)(strchr(OPUS_PARAMS[i], '=') - OPUS_PARAMS[i]),
               OPUS_PARAMS[i]);
      const char *found = strstr(f, name);
      if (found && found < fe) continue;
      strcat(out, ";");
      strcat(out, OPUS_PARAMS[i]);
    }
    strcat(out, fe);
    return out;
  }
  // No fmtp for Opus: one right after its rtpmap.
  snprintf(key, sizeof key, "a=rtpmap:%d ", pt);
  const char *r = strstr(sdp, key);
  const char *re = r ? strpbrk(r, "\r\n") : NULL;
  if (!re) {
    memcpy(out, sdp, len + 1);
    return out;
  }
  size_t at = (size_t)(re - sdp);
  memcpy(out, sdp, at);
  int k = snprintf(out + at, 160, "%sa=fmtp:%d %s;%s;%s;%s", eol, pt, OPUS_PARAMS[0], OPUS_PARAMS[1],
                   OPUS_PARAMS[2], OPUS_PARAMS[3]);
  strcpy(out + at + (size_t)k, re);
  return out;
}

void sdp_offer_dtls_client(char *sdp) {
  static const char from[] = "a=setup:actpass", to[] = "a=setup:active";
  char *at = sdp ? strstr(sdp, from) : NULL;
  if (!at) return;
  // One shorter: write the new value and move the rest of the SDP up a character.
  memmove(at + sizeof to - 1, at + sizeof from - 1, strlen(at + sizeof from - 1) + 1);
  memcpy(at, to, sizeof to - 1);
}
