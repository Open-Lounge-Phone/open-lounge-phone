#include "lan.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

#include "app.h"
#include "audio.h"
#include "esp_log.h"
#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "intercom.h"
#include "lan_crypto.h"
#include "lwip/sockets.h"
#include "nvs.h"
#include "signals.h"

static const char *TAG = "lan";

#define PORT_CTRL 47100
#define PORT_AUDIO 47101
#define HELLO_MS 20000
#define NS "olp"

// Owned by the app task (lan_* are called from it), but for what the audio paths read.
static lan_keys_t s_keys;
static lan_replay_t s_replay;
static ic_t s_ic;
static char s_room[25];
static int s_ctrl = -1, s_audio = -1;
static int64_t s_next_hello;
static ic_state_t s_was = IC_IDLE;
// The call's audio (read by the audio and receive tasks).
static volatile bool s_audio_on;
static volatile uint32_t s_audio_peer;  // network order
static lan_call_keys_t s_call_keys;
static volatile int s_dir;  // 0: we called (we send as the caller), 1: we answered
static volatile uint32_t s_rx_last;

/** Seconds since the epoch, 0 if the phone doesn't know the time yet. */
static uint32_t now_s(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return tv.tv_sec > 1700000000 ? (uint32_t)tv.tv_sec : 0;
}

static void save(const char *room, const char *key) {
  nvs_handle_t h;
  if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
  if (room && key) {
    nvs_set_str(h, "ic_room", room);
    nvs_set_str(h, "ic_key", key);
  } else {
    nvs_erase_key(h, "ic_room");
    nvs_erase_key(h, "ic_key");
  }
  nvs_commit(h);
  nvs_close(h);
}

static void enable(const char *room, const char *key) {
  if (!lan_keys_init(&s_keys, key)) {
    ESP_LOGW(TAG, "intercom key not usable: intercom off");
    return;
  }
  bool renamed = strcmp(room, s_room) != 0;
  snprintf(s_room, sizeof s_room, "%s", room);
  if (renamed) {
    ic_peer_t keep[IC_PEERS];
    memcpy(keep, s_ic.peers, sizeof keep);
    icom_init(&s_ic, s_room);
    memcpy(s_ic.peers, keep, sizeof keep);
  }
  s_next_hello = 0;  // tell the other rooms now
}

void lan_init(void) {
  icom_init(&s_ic, "");
  char room[25] = "", key[64] = "";
  size_t lr = sizeof room, lk = sizeof key;
  nvs_handle_t h;
  if (nvs_open(NS, NVS_READONLY, &h) == ESP_OK) {
    if (nvs_get_str(h, "ic_room", room, &lr) != ESP_OK) room[0] = '\0';
    if (nvs_get_str(h, "ic_key", key, &lk) != ESP_OK) key[0] = '\0';
    nvs_close(h);
  }
  if (room[0] && key[0]) {
    enable(room, key);
    ESP_LOGI(TAG, "INTERCOM on as %s (saved)", s_room);
  }
  memset(key, 0, sizeof key);
}

void lan_config(const char *room, const char *key) {
  if (room && key) {
    char was[25];
    snprintf(was, sizeof was, "%s", s_room);
    bool changed = !s_keys.set || strcmp(was, room);
    lan_keys_t check;
    if (!lan_keys_init(&check, key)) return;
    if (!changed && !memcmp(check.ctl, s_keys.ctl, sizeof check.ctl)) return;
    enable(room, key);
    save(room, key);
    ESP_LOGI(TAG, "INTERCOM on as %s", s_room);
  } else if (s_keys.set) {
    lan_cancel();
    memset(&s_keys, 0, sizeof s_keys);
    s_room[0] = '\0';
    icom_init(&s_ic, "");
    save(NULL, NULL);
    ESP_LOGI(TAG, "INTERCOM off: key forgotten");
  }
}

bool lan_enabled(void) { return s_keys.set; }

void lan_set_engaged(bool engaged) { s_ic.engaged = engaged; }

// ---------------------------------------------------------------- the network

static void broadcast(ic_out_t *o) {
  if (s_ctrl < 0 || !s_keys.set) {
    o->n = 0;
    return;
  }
  struct sockaddr_in to = {.sin_family = AF_INET,
                           .sin_port = htons(PORT_CTRL),
                           .sin_addr.s_addr = htonl(INADDR_BROADCAST)};
  for (int i = 0; i < o->n; i++) {
    char sealed[LAN_SEALED_MAX];
    if (!lan_seal(&s_keys, o->lines[i], now_s(), esp_random(), sealed, sizeof sealed)) continue;
    sendto(s_ctrl, sealed, strlen(sealed), 0, (struct sockaddr *)&to, sizeof to);
    ESP_LOGI(TAG, "IC -> %s", o->lines[i]);
  }
  o->n = 0;
}

static void ctrl_task(void *arg) {
  char buf[LAN_SEALED_MAX];
  for (;;) {
    struct sockaddr_in from;
    socklen_t fl = sizeof from;
    int n = recvfrom(s_ctrl, buf, sizeof buf - 1, 0, (struct sockaddr *)&from, &fl);
    if (n <= 0) {
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }
    buf[n] = '\0';
    char *d = malloc((size_t)n + 24);
    if (!d) continue;
    snprintf(d, (size_t)n + 24, "%lu|%s", (unsigned long)from.sin_addr.s_addr, buf);
    app_post(EV_LAN, 0, d);
  }
}

static void audio_task(void *arg) {
  uint8_t pkt[512], frame[512];
  for (;;) {
    struct sockaddr_in from;
    socklen_t fl = sizeof from;
    int n = recvfrom(s_audio, pkt, sizeof pkt, 0, (struct sockaddr *)&from, &fl);
    if (n <= 0 || !s_audio_on || from.sin_addr.s_addr != s_audio_peer) continue;
    uint32_t seq;
    size_t len;
    // From the other side: the other direction. A packet that doesn't check is dropped.
    if (!lan_audio_open(&s_call_keys, 1 - s_dir, pkt, (size_t)n, &seq, frame, &len)) continue;
    if (seq <= s_rx_last && s_rx_last - seq < 1000) continue;  // old or repeated
    s_rx_last = seq;
    audio_rx_ulaw(frame, len);
  }
}

static void audio_send(const uint8_t *ulaw, size_t n, uint32_t pts) {
  static uint32_t seq;
  uint8_t pkt[512];
  if (s_audio < 0 || !s_audio_on || !s_audio_peer) return;
  size_t len = lan_audio_seal(&s_call_keys, s_dir, ++seq, ulaw, n, pkt, sizeof pkt);
  if (!len) return;
  struct sockaddr_in to = {.sin_family = AF_INET,
                           .sin_port = htons(PORT_AUDIO),
                           .sin_addr.s_addr = s_audio_peer};
  sendto(s_audio, pkt, len, 0, (struct sockaddr *)&to, sizeof to);
}

static int udp(int port, bool bcast) {
  int s = socket(AF_INET, SOCK_DGRAM, 0);
  if (s < 0) return -1;
  int on = 1;
  setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &on, sizeof on);
  if (bcast) setsockopt(s, SOL_SOCKET, SO_BROADCAST, &on, sizeof on);
  struct sockaddr_in a = {.sin_family = AF_INET,
                          .sin_port = htons(port),
                          .sin_addr.s_addr = htonl(INADDR_ANY)};
  if (bind(s, (struct sockaddr *)&a, sizeof a) < 0) {
    close(s);
    return -1;
  }
  return s;
}

void lan_net_up(void) {
  if (s_ctrl >= 0) return;
  s_ctrl = udp(PORT_CTRL, true);
  s_audio = udp(PORT_AUDIO, false);
  if (s_ctrl >= 0) xTaskCreate(ctrl_task, "lan_ic", 4096, NULL, 5, NULL);
  if (s_audio >= 0) xTaskCreate(audio_task, "lan_au", 4096, NULL, 6, NULL);
  ESP_LOGI(TAG, "intercom on UDP %d/%d%s", PORT_CTRL, PORT_AUDIO, s_ctrl >= 0 ? "" : " (failed)");
  s_next_hello = 0;
}

/** After any change: the call's audio, a chime. */
static void ic_sync(void) {
  bool talk = s_ic.st == IC_TALK;
  if (talk && !s_audio_on) {
    lan_call_keys(&s_keys, s_ic.id, &s_call_keys);
    s_dir = s_ic.caller ? 0 : 1;
    s_rx_last = 0;
    s_audio_peer = s_ic.peer_ip;
    s_audio_on = true;
    audio_call(true, audio_send);
    ESP_LOGI(TAG, "IC talking with %s", s_ic.peer);
  } else if (!talk && s_audio_on) {
    s_audio_on = false;
    s_audio_peer = 0;
    audio_call(false, NULL);
  }
  if (s_ic.chimed) {
    s_ic.chimed = false;
    signals_beep(BEEP_NOTICE);
    ESP_LOGI(TAG, "IC chime [%s|%s]", s_ic.note[0], s_ic.note[1]);
  }
  if (s_ic.st != s_was) {
    ESP_LOGI(TAG, "IC state %d -> %d", s_was, s_ic.st);
    s_was = s_ic.st;
  }
}

void lan_event(char *data, int64_t now) {
  if (!data) return;
  char *line = strchr(data, '|');
  if (line && s_keys.set) {
    *line++ = '\0';
    char inner[IC_LINE];
    // Not sealed with the space's key, stale or a replay: dropped (a neighbour, or old labs).
    if (lan_open(&s_keys, &s_replay, line, now_s(), inner, sizeof inner)) {
      ESP_LOGI(TAG, "IC <- %s", inner);
      ic_out_t o = {0};
      icom_msg(&s_ic, (uint32_t)strtoul(data, NULL, 10), inner, now, &o);
      broadcast(&o);
      ic_sync();
    } else {
      ESP_LOGD(TAG, "IC message dropped (not ours)");
    }
  }
  free(data);
}

void lan_tick(int64_t now) {
  if (!s_keys.set) return;
  ic_out_t o = {0};
  if (s_ctrl >= 0 && now >= s_next_hello) {
    s_next_hello = now + HELLO_MS;
    icom_hello(&s_ic, &o);
  }
  icom_tick(&s_ic, now, &o);
  broadcast(&o);
  ic_sync();
}

bool lan_call(const char *room, bool door, int64_t now) {
  if (!s_keys.set) return false;
  ic_out_t o = {0};
  bool ok = icom_call(&s_ic, room, door, esp_random(), now, &o);
  broadcast(&o);
  ic_sync();
  return ok;
}

void lan_chime(const char *text) {
  if (!s_keys.set) return;
  ic_out_t o = {0};
  icom_chime(&s_ic, text, &o);
  broadcast(&o);
}

bool lan_hook(bool up, int64_t now) {
  if (!s_keys.set || s_ic.st == IC_IDLE) return false;
  ic_out_t o = {0};
  icom_hook(&s_ic, up, now, &o);
  broadcast(&o);
  ic_sync();
  return true;
}

bool lan_cancel(void) {
  if (s_ic.st == IC_IDLE) return false;
  ic_out_t o = {0};
  icom_cancel(&s_ic, &o);
  broadcast(&o);
  ic_sync();
  return true;
}

int lan_lines(char out[2][41], int64_t now) { return s_keys.set ? icom_lines(&s_ic, now, out) : 0; }
bool lan_ringing(void) { return s_ic.st == IC_RINGING; }
bool lan_busy(void) { return s_ic.st != IC_IDLE; }
int lan_rooms(char names[][25], int max, int64_t now) {
  return s_keys.set ? icom_rooms(&s_ic, now, names, max) : 0;
}
