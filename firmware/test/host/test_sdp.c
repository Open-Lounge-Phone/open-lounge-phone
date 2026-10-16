#include <stdlib.h>

#include "check.h"
#include "sdp.h"

static const char *CHROME =
    "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126\r\n"
    "a=rtpmap:111 opus/48000/2\r\na=rtcp-fb:111 transport-cc\r\n"
    "a=fmtp:111 minptime=10;useinbandfec=1\r\na=rtpmap:63 red/48000/2\r\n"
    "a=rtpmap:9 G722/8000\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:8 PCMA/8000\r\n";

TEST(sdp_finds_the_audio_codecs) {
  CHECK(sdp_audio_codecs(CHROME) == (SDP_OPUS | SDP_PCMU));
  CHECK(sdp_audio_codecs("m=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=rtpmap:0 PCMU/8000\r\n") == SDP_PCMU);
  // Payload type 0 without an rtpmap is still PCMU; Opus under another number is found by name.
  CHECK(sdp_audio_codecs("m=audio 9 RTP/AVP 0 96\na=rtpmap:96 OPUS/48000/2\n") == (SDP_OPUS | SDP_PCMU));
  // An rtpmap that isn't on the m-line doesn't count.
  CHECK(sdp_audio_codecs("m=audio 9 RTP/AVP 0\na=rtpmap:111 opus/48000/2\n") == SDP_PCMU);
  CHECK(sdp_audio_codecs("v=0\r\n") == 0);
  CHECK(sdp_audio_codecs(NULL) == 0);
}

TEST(sdp_adds_our_opus_params) {
  char *a = sdp_with_opus_params(CHROME);  // has some: only the missing ones are added
  CHECK(strstr(a, "a=fmtp:111 minptime=10;useinbandfec=1;maxplaybackrate=16000;"
                  "sprop-maxcapturerate=16000\r\na=rtpmap:63") != NULL);
  free(a);
  const char *bare = "m=audio 9 UDP/TLS/RTP/SAVPF 111 0\r\na=rtpmap:111 opus/48000/2\r\n"
                     "a=rtpmap:0 PCMU/8000\r\n";
  char *b = sdp_with_opus_params(bare);
  CHECK_STR(b, "m=audio 9 UDP/TLS/RTP/SAVPF 111 0\r\na=rtpmap:111 opus/48000/2\r\n"
               "a=fmtp:111 minptime=10;useinbandfec=1;maxplaybackrate=16000;"
               "sprop-maxcapturerate=16000\r\na=rtpmap:0 PCMU/8000\r\n");
  free(b);
  const char *pcmu = "m=audio 9 RTP/AVP 0\na=rtpmap:0 PCMU/8000\n";
  char *c = sdp_with_opus_params(pcmu);
  CHECK_STR(c, pcmu);  // nothing to do
  free(c);
}

TEST(sdp_makes_an_offer_the_dtls_client) {
  char a[] = "v=0\r\na=fingerprint:sha-256 AA\r\na=setup:actpass\r\na=ice-ufrag:x\r\n";
  sdp_offer_dtls_client(a);
  CHECK_STR(a, "v=0\r\na=fingerprint:sha-256 AA\r\na=setup:active\r\na=ice-ufrag:x\r\n");
  char b[] = "v=0\r\na=setup:passive\r\n";  // an answer, or already decided: untouched
  sdp_offer_dtls_client(b);
  CHECK_STR(b, "v=0\r\na=setup:passive\r\n");
  char c[] = "a=setup:actpass";  // at the very end, no line break
  sdp_offer_dtls_client(c);
  CHECK_STR(c, "a=setup:active");
  sdp_offer_dtls_client(NULL);
}

