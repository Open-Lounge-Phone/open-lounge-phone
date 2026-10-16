#include "esp_heap_caps.h"
#include "media.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app.h"
#include "audio.h"
#include "esp_log.h"
#include "esp_peer.h"
#include "esp_peer_default.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "sdkconfig.h"
#include "sdp.h"

static const char *TAG = "media";
// The other side's candidates are pooled for a moment after its SDP (they arrive in a burst) and
// the best ICE_REMOTE_MAX go to esp_peer, which drops the rest (ice_cand_pick: IPv4/UDP only,
// host before srflx before relay).
#define MAX_PENDING_CANDIDATES 24
#define CANDIDATE_SETTLE_MS 400

typedef enum { CMD_START, CMD_SDP, CMD_CANDIDATE, CMD_STOP } cmd_type_t;
typedef struct {
  cmd_type_t type;
  char *text;         // SDP / candidate / ICE servers JSON (malloc'd)
  bool offerer;
} cmd_t;

static QueueHandle_t s_cmds;
static SemaphoreHandle_t s_peer_lock;  // guards s_peer against the audio task's sends
static esp_peer_handle_t s_peer;
static volatile bool s_connected;
static bool s_have_remote;
static char *s_pending[MAX_PENDING_CANDIDATES];
static int s_npending;
static int s_fed;              // remote candidates given to esp_peer in this call
static int64_t s_settle_at;    // when the pooled candidates go in (after the remote SDP)
static ice_mode_t s_ice_mode = ICE_ALL;
// The codec this phone sends (fixed when the peer opens: esp_peer sends what it was opened with).
// Opus unless the other side can't (docs/audio.md item 2); PCMU is offered and accepted too.
static voice_codec_t s_send_codec;
static char *s_ice_json;  // this call's ICE servers, to open again with PCMU
static bool s_offerer;
// `audio codec pcmu` (console, not saved): every call as in 0.9.5, PCMU alone, for comparing on a
// board. Opus (the default) offers and answers with both codecs, sending Opus.
static bool s_opus = true;
// A call the phone places offers `a=setup:active`: the phone is the DTLS client, as when it
// answers (the case that connects). As DTLS server (`actpass` answered `active`) the phone
// logged "SRTP connected OK" but the other side never finished its handshake, the phone never
// reported connected and stopped answering consent checks. `rtc dtls auto` puts actpass back.
static bool s_dtls_client = true;
#if CONFIG_OLP_ICE_PREFER_TLS
#define PREFER_TLS true
#else
#define PREFER_TLS false
#endif
// The app task's view (it is the only writer).
static char s_call_id[65];
// For `status`.
static int64_t s_started_ms, s_connected_ms;
static int s_last_state = -1;
static char s_servers_log[3 * ICE_URL_LEN];

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

static const char *state_name(esp_peer_state_t s) {
  static const char *names[] = {"closed",       "disconnected", "new",       "gathering",
                                "pairing",      "paired",       "connecting", "connected",
                                "failed",       "dc-connected", "dc-opened",  "dc-closed",
                                "dc-disconnected", "remote-audio", "remote-audio-removed"};
  return (unsigned)s < sizeof names / sizeof names[0] ? names[s] : "?";
}

// --- esp_peer callbacks (run on the rtc task, inside esp_peer_main_loop) ---------------------

static void send_audio(const uint8_t *data, size_t n, uint32_t pts_ms) {
  if (!s_connected) return;
  if (xSemaphoreTake(s_peer_lock, 0) != pdTRUE) return;  // closing: skip this frame
  if (s_peer) {
    esp_peer_audio_frame_t f = {.pts = pts_ms, .data = (uint8_t *)data, .size = (int)n};
    esp_peer_send_audio(s_peer, &f);
  }
  xSemaphoreGive(s_peer_lock);
}

static volatile bool s_closing;  // close_peer: its own disconnect isn't news for the app

static int on_state(esp_peer_state_t state, void *ctx) {
  if (s_closing) return 0;
  s_last_state = state;
  ESP_LOGI(TAG, "RTC state %s (%d ms; internal free %u, largest %u)", state_name(state),
           (int)(now_ms() - s_started_ms), (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
           (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
  if (state == ESP_PEER_STATE_CONNECTED) {
    s_connected = true;
    s_connected_ms = now_ms();
    ESP_LOGI(TAG, "RTC CONNECTED: ICE + DTLS-SRTP up in %d ms", (int)(s_connected_ms - s_started_ms));
    audio_call(true, s_send_codec, send_audio);
    app_post(EV_RTC_STATE, 1, NULL);
  } else if (state == ESP_PEER_STATE_DISCONNECTED || state == ESP_PEER_STATE_CONNECT_FAILED) {
    bool was = s_connected;
    s_connected = false;
    audio_call(false, VOICE_PCMU, NULL);
    ESP_LOGW(TAG, "RTC %s", state == ESP_PEER_STATE_CONNECT_FAILED ? "FAILED" : "DISCONNECTED");
    app_post(EV_RTC_STATE, was ? 2 : 3, NULL);
  }
  return 0;
}

static int on_msg(esp_peer_msg_t *msg, void *ctx) {
  if (msg->type != ESP_PEER_MSG_TYPE_SDP || !msg->data) return 0;
  ESP_LOGI(TAG, "local SDP ready (%d bytes, %d ms)", msg->size, (int)(now_ms() - s_started_ms));
  char *raw = malloc((size_t)msg->size + 1);
  if (!raw) return 0;
  memcpy(raw, msg->data, (size_t)msg->size);
  raw[msg->size] = '\0';
  // Our Opus receive parameters (FEC from the other side, 16 kHz is enough).
  char *sdp = sdp_with_opus_params(raw);
  if (sdp) free(raw);
  else sdp = raw;
  if (s_offerer && s_dtls_client) sdp_offer_dtls_client(sdp);
  app_post(EV_RTC_SDP, 0, sdp);  // the app sends it as rtc.sdp (offer or answer)
  return 0;
}

static const char *codec_name(esp_peer_audio_codec_t c) {
  return c == ESP_PEER_AUDIO_CODEC_OPUS    ? "opus"
         : c == ESP_PEER_AUDIO_CODEC_G711U ? "pcmu"
         : c == ESP_PEER_AUDIO_CODEC_G711A ? "pcma"
                                           : "none";
}

static int on_audio_info(esp_peer_audio_stream_info_t *info, void *ctx) {
  ESP_LOGI(TAG, "remote audio: codec %d, %lu Hz, %d ch", info->codec, (unsigned long)info->sample_rate,
           info->channel);
  voice_codec_t rx = info->codec == ESP_PEER_AUDIO_CODEC_OPUS ? VOICE_OPUS : VOICE_PCMU;
  audio_rx_codec(rx);
  ESP_LOGI(TAG, "CODEC send=%s recv=%s", voice_codec_name(s_send_codec), codec_name(info->codec));
  return 0;
}

static int s_rx_logged;
static int on_audio_data(esp_peer_audio_frame_t *frame, void *ctx) {
  if (frame->data && frame->size > 0) audio_rx_packet(frame->data, (size_t)frame->size, frame->pts);
  if (s_rx_logged < 5) {
    s_rx_logged++;
    ESP_LOGI(TAG, "RTP in: pts %lu, %d bytes", (unsigned long)frame->pts, frame->size);
  }
  return 0;
}

static int on_video_info(esp_peer_video_stream_info_t *info, void *ctx) { return 0; }
static int on_video_data(esp_peer_video_frame_t *frame, void *ctx) { return 0; }
static int on_data(esp_peer_data_frame_t *frame, void *ctx) { return 0; }

// --- the task ------------------------------------------------------------------------------

static void close_peer(void) {
  s_connected = false;
  audio_call(false, VOICE_PCMU, NULL);
  xSemaphoreTake(s_peer_lock, portMAX_DELAY);
  if (s_peer) {
    s_closing = true;
    esp_peer_disconnect(s_peer);
    esp_peer_close(s_peer);
    s_closing = false;
    s_peer = NULL;
    ESP_LOGI(TAG, "RTC closed");
  }
  xSemaphoreGive(s_peer_lock);
  for (int i = 0; i < s_npending; i++) free(s_pending[i]);
  s_npending = 0;
  s_fed = 0;
  s_have_remote = false;
}

static void send_candidate(const char *c) {
  esp_peer_msg_t m = {.type = ESP_PEER_MSG_TYPE_CANDIDATE, .data = (uint8_t *)c, .size = (int)strlen(c)};
  int r = esp_peer_send_msg(s_peer, &m);
  if (r) ESP_LOGW(TAG, "remote candidate rejected (%d)", r);
  s_fed++;
}

/** The pooled candidates: the best that still fit go to esp_peer, the rest are dropped. */
static void feed_pool(void) {
  int pick[ICE_REMOTE_MAX];
  int room = ICE_REMOTE_MAX - s_fed;
  int n = room > 0 ? ice_cand_pick((const char *const *)s_pending, s_npending, pick, room) : 0;
  for (int i = 0; i < n; i++) send_candidate(s_pending[pick[i]]);
  if (s_npending > n)
    ESP_LOGI(TAG, "remote candidates: %d used, %d left out (IPv6, TCP, or past %d)", n,
             s_npending - n, ICE_REMOTE_MAX);
  for (int i = 0; i < s_npending; i++) free(s_pending[i]);
  s_npending = 0;
}

static void start_peer(const char *ice_json, bool offerer, voice_codec_t codec) {
  close_peer();
  if (ice_json != s_ice_json) {
    free(s_ice_json);
    s_ice_json = strdup(ice_json ? ice_json : "[]");
  }
  s_offerer = offerer;
#if CONFIG_OLP_CALL_OPUS
  s_send_codec = codec;
#else
  s_send_codec = VOICE_PCMU;
#endif
  // The TCP/TLS relay only when it was asked for (Kconfig, or `ice tcp` / `ice tls`).
#if CONFIG_OLP_ICE_TCP_RELAY
  bool tcp_relay = true;
#else
  bool tcp_relay = s_ice_mode == ICE_TCP || s_ice_mode == ICE_TLS;
#endif
  ice_mode_t pick_mode = !tcp_relay && s_ice_mode == ICE_ALL ? ICE_UDP : s_ice_mode;
  // esp_peer may keep pointers into its configuration: keep it all static.
  static ice_server_t servers[ICE_MAX];
  static esp_peer_ice_server_cfg_t cfgs[ICE_MAX];
  static esp_peer_default_cfg_t extra;
  cJSON *list = cJSON_Parse(ice_json ? ice_json : "[]");
  int n = ice_pick(list, pick_mode, PREFER_TLS, servers, ICE_MAX);
  cJSON_Delete(list);
  s_servers_log[0] = '\0';
  for (int i = 0; i < n; i++) {
    cfgs[i] = (esp_peer_ice_server_cfg_t){
        .stun_url = servers[i].url,
        .user = servers[i].user[0] ? servers[i].user : NULL,
        .psw = servers[i].cred[0] ? servers[i].cred : NULL,
    };
    // URLs only: the credentials are never logged.
    if (i) strlcat(s_servers_log, " ", sizeof s_servers_log);
    strlcat(s_servers_log, servers[i].url, sizeof s_servers_log);
  }
  extra = (esp_peer_default_cfg_t){
      .agent_recv_timeout = CONFIG_OLP_RTC_AGENT_TIMEOUT_MS,
      .rtp_cfg =
          {
              .audio_recv_jitter = {.cache_size = 8 * 1024, .cache_timeout = 100},
              .send_pool_size = 8 * 1024,
              .send_queue_num = 32,
          },
      .max_candidates = ICE_REMOTE_MAX,  // the other side's: media.c feeds the best (ice_cand_pick)
      // TURN over TCP/TLS needs this, but in esp_peer 1.5.6 it doesn't work (README "Call audio":
      // TLS gives up before connecting, TCP pairs but DTLS reads fail) and a TCP/TLS server in the
      // list stalls gathering for the whole call. Off unless asked for.
      .tcp_support = tcp_relay,
  };
  esp_peer_cfg_t cfg = {
      .server_lists = n ? cfgs : NULL,  // esp_peer refuses an empty list that isn't NULL
      .server_num = (uint8_t)n,
      .role = offerer ? ESP_PEER_ROLE_CONTROLLING : ESP_PEER_ROLE_CONTROLLED,
      .ice_trans_policy = (s_ice_mode == ICE_TCP || s_ice_mode == ICE_TLS) ? ESP_PEER_ICE_TRANS_POLICY_RELAY
                                                : ESP_PEER_ICE_TRANS_POLICY_ALL,
      .audio_info = s_send_codec == VOICE_OPUS
                        ? (esp_peer_audio_stream_info_t){.codec = ESP_PEER_AUDIO_CODEC_OPUS,
                                                         .sample_rate = 16000, .channel = 1}
                        : (esp_peer_audio_stream_info_t){.codec = ESP_PEER_AUDIO_CODEC_G711U,
                                                         .sample_rate = 8000, .channel = 1},
#if CONFIG_OLP_CALL_OPUS
      // Both in the SDP: Opus and PCMU (an offer lists both, an answer what both sides have).
      .codec_caps = s_opus ? (ESP_PEER_CAPS_AUD_OPUS | ESP_PEER_CAPS_AUD_G711U) : 0,
#endif
      .audio_dir = ESP_PEER_MEDIA_DIR_SEND_RECV,
      .video_dir = ESP_PEER_MEDIA_DIR_NONE,
      .no_auto_reconnect = true,
      .enable_data_channel = false,
      .extra_cfg = &extra,
      .extra_size = sizeof extra,
      .on_state = on_state,
      .on_msg = on_msg,
      .on_video_info = on_video_info,
      .on_audio_info = on_audio_info,
      .on_video_data = on_video_data,
      .on_audio_data = on_audio_data,
      .on_data = on_data,
  };
  s_started_ms = now_ms();
  s_connected_ms = 0;
  s_rx_logged = 0;
  ESP_LOGI(TAG, "RTC start: %s, ICE %s [%s], sends %s", offerer ? "offerer" : "answerer",
           ice_mode_name(s_ice_mode), s_servers_log, voice_codec_name(s_send_codec));
  esp_peer_handle_t peer = NULL;
  int r = esp_peer_open(&cfg, esp_peer_get_default_impl(), &peer);
  if (r != ESP_PEER_ERR_NONE || !peer) {
    ESP_LOGE(TAG, "esp_peer_open failed (%d)", r);
    app_post(EV_RTC_STATE, 3, NULL);
    return;
  }
  xSemaphoreTake(s_peer_lock, portMAX_DELAY);
  s_peer = peer;
  xSemaphoreGive(s_peer_lock);
  r = esp_peer_new_connection(s_peer);
  if (r != ESP_PEER_ERR_NONE) ESP_LOGE(TAG, "esp_peer_new_connection failed (%d)", r);
}

static void handle(cmd_t *c) {
  switch (c->type) {
    case CMD_START:
      start_peer(c->text, c->offerer, s_opus ? VOICE_OPUS : VOICE_PCMU);
      break;
    case CMD_SDP:
      if (!s_peer) break;
      if (s_have_remote) {
        // A second offer mid-call is the other side restarting ICE: esp_peer 1.5.6 can't apply
        // one to a running connection, so it's left unanswered (the restart then gives up).
        ESP_LOGW(TAG, "remote SDP mid-call (an ICE restart) ignored: not supported here");
        break;
      }
      {
        unsigned have = sdp_audio_codecs(c->text);
        ESP_LOGI(TAG, "remote SDP has%s%s", have & SDP_OPUS ? " opus" : "", have & SDP_PCMU ? " pcmu" : "");
        if (s_send_codec == VOICE_OPUS && !(have & SDP_OPUS) && !s_offerer) {
          // An offer without Opus: open again sending PCMU, before answering it.
          ESP_LOGI(TAG, "no Opus in the offer: PCMU");
          start_peer(s_ice_json, false, VOICE_PCMU);
          if (!s_peer) break;
        } else if (s_send_codec == VOICE_OPUS && !(have & SDP_OPUS)) {
          ESP_LOGW(TAG, "the answer has no Opus");
        }
        esp_peer_msg_t m = {.type = ESP_PEER_MSG_TYPE_SDP, .data = (uint8_t *)c->text,
                            .size = (int)strlen(c->text)};
        int r = esp_peer_send_msg(s_peer, &m);
        ESP_LOGI(TAG, "remote SDP applied (%d)", r);
        s_have_remote = true;
        s_settle_at = now_ms() + CANDIDATE_SETTLE_MS;  // the trickled burst, then the best go in
      }
      break;
    case CMD_CANDIDATE:
      if (!s_peer) break;
      if (ice_cand_rank(c->text) < 0) {
        ESP_LOGD(TAG, "remote candidate left out (IPv6 or TCP)");
      } else if (s_have_remote && now_ms() >= s_settle_at && !s_npending) {
        if (s_fed < ICE_REMOTE_MAX) send_candidate(c->text);  // late ones, while there's room
        else ESP_LOGI(TAG, "remote candidate left out: %d already", ICE_REMOTE_MAX);
      } else if (s_npending < MAX_PENDING_CANDIDATES) {
        s_pending[s_npending++] = c->text;  // pooled until the remote SDP and a moment after
        c->text = NULL;
      }
      break;
    case CMD_STOP:
      close_peer();
      break;
  }
  free(c->text);
}

static void task(void *arg) {
  // A DTLS certificate (ECDSA P-256) made once, so a call doesn't wait for key generation.
  int64_t t0 = now_ms();
  int r = esp_peer_pre_generate_cert();
  ESP_LOGI(TAG, "DTLS certificate ready (%d, %d ms)", r, (int)(now_ms() - t0));
  for (;;) {
    cmd_t c;
    while (xQueueReceive(s_cmds, &c, s_peer ? 0 : pdMS_TO_TICKS(100)) == pdTRUE) handle(&c);
    if (s_peer && s_have_remote && s_npending && now_ms() >= s_settle_at) feed_pool();
    if (s_peer) {
      esp_peer_main_loop(s_peer);
      vTaskDelay(pdMS_TO_TICKS(5));
    }
  }
}

static void post(cmd_type_t type, const char *text, bool offerer) {
  cmd_t c = {.type = type, .text = text ? strdup(text) : NULL, .offerer = offerer};
  if (xQueueSend(s_cmds, &c, pdMS_TO_TICKS(200)) != pdTRUE) {
    ESP_LOGW(TAG, "command queue full");
    free(c.text);
  }
}

void media_init(void) {
  s_cmds = xQueueCreate(24, sizeof(cmd_t));
  s_peer_lock = xSemaphoreCreateMutex();
  // esp_peer logs TURN credentials at INFO ("Get candidate success user:… psw:…"): keep its
  // ICE agent at WARN unless debugging (`rtc log`).
  esp_log_level_set("AGENT", ESP_LOG_WARN);
  xTaskCreatePinnedToCore(task, "rtc", CONFIG_OLP_RTC_TASK_STACK, NULL, 5, NULL, 0);
}

void media_start(const char *call_id, bool offerer, const cJSON *ice_servers) {
  snprintf(s_call_id, sizeof s_call_id, "%s", call_id);
  char *json = ice_servers ? cJSON_PrintUnformatted(ice_servers) : NULL;
  post(CMD_START, json ? json : "[]", offerer);
  free(json);
}

void media_remote_sdp(const char *call_id, const char *sdp) {
  if (strcmp(call_id, s_call_id)) return;
  post(CMD_SDP, sdp, false);
}

void media_remote_candidate(const char *call_id, const char *candidate) {
  if (strcmp(call_id, s_call_id) || !candidate || !candidate[0]) return;
  post(CMD_CANDIDATE, candidate, false);
}

void media_stop(void) {
  if (!s_call_id[0]) return;
  s_call_id[0] = '\0';
  post(CMD_STOP, NULL, false);
}

const char *media_call_id(void) { return s_call_id; }
bool media_active(void) { return s_call_id[0] != '\0'; }
bool media_connected(void) { return s_connected; }
void media_set_ice_mode(ice_mode_t mode) { s_ice_mode = mode; }
void media_set_opus(bool on) { s_opus = on; }
void media_set_dtls_client(bool on) { s_dtls_client = on; }
bool media_dtls_client(void) { return s_dtls_client; }
bool media_opus(void) { return s_opus; }
ice_mode_t media_ice_mode(void) { return s_ice_mode; }

void media_print_status(void) {
  printf("RTC call=%s state=%s connected=%d ice=%s servers=[%s] setup_ms=%d\n",
         s_call_id[0] ? s_call_id : "-", s_last_state < 0 ? "-" : state_name(s_last_state),
         s_connected, ice_mode_name(s_ice_mode), s_servers_log,
         s_connected_ms ? (int)(s_connected_ms - s_started_ms) : -1);
}
