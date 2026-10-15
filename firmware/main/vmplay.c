#include "vmplay.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app.h"
#include "audio.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "net.h"
#include "prov_core.h"
#include "wav.h"

static const char *TAG = "vmplay";

#define MAX_ITEMS 8
#define MAX_BYTES (2 * 1024 * 1024 + 64)
#define FETCH_TIMEOUT_MS 8000
#define NOTE_MS 3000
#define CANT_PLAY_MS 4000
#define RATE 8000

typedef enum { VP_IDLE, VP_FETCHING, VP_LOADING, VP_PLAYING, VP_CANT_PLAY, VP_NOTE } vp_stage_t;

typedef struct {
  char id[48];
  char from[25];
  char ticket[200];     // a play ticket, or (vmplay_play_url) the whole http(s) URL
  int duration_ms;
} item_t;

static vmplay_send_fn s_send;
static vp_stage_t s_stage = VP_IDLE;
static bool s_clear;
static item_t s_items[MAX_ITEMS];
static int s_n, s_cur;
static int64_t s_at;
static char s_note[2][25];
static uint8_t *s_buf;          // the downloaded file (PSRAM)
static volatile size_t s_len;   // its length (set by the download task)
static wav_t s_wav;
static volatile bool s_downloading;  // the download task owns s_buf until it reports back

void vmplay_init(vmplay_send_fn send) { s_send = send; }
bool vmplay_active(void) { return s_stage != VP_IDLE; }

static void note(const char *a, const char *b, int64_t now_ms) {
  snprintf(s_note[0], 25, "%s", a);
  snprintf(s_note[1], 25, "%s", b ? b : "");
  s_stage = VP_NOTE;
  s_at = now_ms;
}

static void release(void) {
  audio_play(NULL, 0);
  free(s_buf);
  s_buf = NULL;
}

static void send_simple(const char *t, const char *id) {
  cJSON *m = cJSON_CreateObject();
  cJSON_AddStringToObject(m, "t", t);
  if (id) cJSON_AddStringToObject(m, "id", id);
  s_send(m);
}

void vmplay_start(bool clear, int64_t now_ms) {
  if (s_downloading) return;  // still finishing the last one
  vmplay_stop();
  s_clear = clear;
  s_n = s_cur = 0;
  s_stage = VP_FETCHING;
  s_at = now_ms;
  send_simple("voicemail.fetch", NULL);
}

static void download_task(void *arg) {
  char url[PROV_SERVER_MAX + 200], base[PROV_SERVER_MAX + 8];
  char srv[PROV_SERVER_MAX];
  net_server_url(srv, sizeof srv);
  if (!strncmp(srv, "wss://", 6)) snprintf(base, sizeof base, "https://%s", srv + 6);
  else if (!strncmp(srv, "ws://", 5)) snprintf(base, sizeof base, "http://%s", srv + 5);
  else snprintf(base, sizeof base, "%s", srv);
  size_t bl = strlen(base);
  if (bl && base[bl - 1] == '/') base[bl - 1] = '\0';
  const char *t = (const char *)arg;
  if (!strncmp(t, "http://", 7) || !strncmp(t, "https://", 8)) snprintf(url, sizeof url, "%s", t);
  else snprintf(url, sizeof url, "%s/api/vm/play?ticket=%s", base, t);
  bool ok = false;
  esp_http_client_config_t cfg = {
      .url = url,
      .crt_bundle_attach = esp_crt_bundle_attach,
      .timeout_ms = 20000,
  };
  esp_http_client_handle_t c = esp_http_client_init(&cfg);
  if (c && esp_http_client_open(c, 0) == ESP_OK) {
    esp_http_client_fetch_headers(c);
    int status = esp_http_client_get_status_code(c);
    size_t got = 0;
    if (status == 200) {
      for (;;) {
        int r = esp_http_client_read(c, (char *)s_buf + got, (int)(MAX_BYTES - got));
        if (r <= 0) break;
        got += (size_t)r;
        if (got >= MAX_BYTES) break;
      }
      ok = got > 44;
    }
    s_len = got;
    ESP_LOGI(TAG, "download: HTTP %d, %u bytes", status, (unsigned)got);
  }
  if (c) esp_http_client_cleanup(c);
  app_post(EV_VM_LOADED, ok, NULL);
  vTaskDelete(NULL);
}

static void next(int64_t now_ms);

static void play_current(int64_t now_ms) {
  item_t *it = &s_items[s_cur];
  release();
  if (!it->ticket[0]) {  // a format phones can't play
    s_stage = VP_CANT_PLAY;
    s_at = now_ms;
    return;
  }
  s_buf = heap_caps_malloc(MAX_BYTES, MALLOC_CAP_SPIRAM);
  if (!s_buf) {
    note("COULDN'T PLAY", "NO MEMORY", now_ms);
    return;
  }
  s_len = 0;
  s_stage = VP_LOADING;
  s_at = now_ms;
  // The ticket is single use: hand the task its own copy, then forget it.
  static char ticket[200];
  snprintf(ticket, sizeof ticket, "%s", it->ticket);
  it->ticket[0] = '\0';
  s_downloading = true;
  if (xTaskCreate(download_task, "vm_dl", 8192, ticket, 4, NULL) != pdPASS) {
    s_downloading = false;
    release();
    note("COULDN'T PLAY", "TRY AGAIN", now_ms);
  }
}

void vmplay_play_url(const char *url, const char *title, int64_t now_ms) {
  if (s_downloading || !url) return;
  vmplay_stop();
  s_clear = false;
  s_n = 1;
  s_cur = 0;
  memset(&s_items[0], 0, sizeof s_items[0]);
  snprintf(s_items[0].from, sizeof s_items[0].from, "%s", title ? title : "STORY");
  snprintf(s_items[0].ticket, sizeof s_items[0].ticket, "%s", url);
  play_current(now_ms);
}

void vmplay_items(const cJSON *msg, int64_t now_ms) {
  if (s_stage != VP_FETCHING) return;
  s_n = 0;
  const cJSON *x;
  cJSON_ArrayForEach(x, cJSON_GetObjectItemCaseSensitive(msg, "items")) {
    if (s_n >= MAX_ITEMS) break;
    item_t *it = &s_items[s_n];
    memset(it, 0, sizeof *it);
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(x, "id");
    const cJSON *from = cJSON_GetObjectItemCaseSensitive(x, "from");
    const cJSON *ticket = cJSON_GetObjectItemCaseSensitive(x, "ticket");
    const cJSON *dur = cJSON_GetObjectItemCaseSensitive(x, "durationMs");
    if (!cJSON_IsString(id)) continue;
    snprintf(it->id, sizeof it->id, "%s", id->valuestring);
    snprintf(it->from, sizeof it->from, "%s", cJSON_IsString(from) ? from->valuestring : "");
    for (char *c = it->from; *c; c++) *c = (char)toupper((unsigned char)*c);
    if (cJSON_IsString(ticket)) snprintf(it->ticket, sizeof it->ticket, "%s", ticket->valuestring);
    it->duration_ms = cJSON_IsNumber(dur) ? dur->valueint : 0;
    s_n++;
  }
  ESP_LOGI(TAG, "VOICEMAIL %d unheard%s", s_n, s_clear ? " (clearing)" : "");
  if (s_n == 0) {
    note("NO NEW VOICEMAIL", NULL, now_ms);
    return;
  }
  if (s_clear) {
    for (int i = 0; i < s_n; i++) send_simple("voicemail.heard", s_items[i].id);
    char t[25];
    snprintf(t, sizeof t, "%d CLEARED", s_n);
    note("VOICEMAIL", t, now_ms);
    return;
  }
  s_cur = 0;
  play_current(now_ms);
}

void vmplay_loaded(bool ok, int64_t now_ms) {
  s_downloading = false;
  if (s_stage != VP_LOADING) {  // stopped meanwhile
    release();
    return;
  }
  if (!ok || !wav_parse(s_buf, s_len, &s_wav) || s_wav.rate != RATE) {
    ESP_LOGW(TAG, "can't play message %s (%s)", s_items[s_cur].id, ok ? "not 8 kHz WAV" : "download");
    release();
    s_stage = VP_CANT_PLAY;
    s_at = now_ms;
    return;
  }
  audio_play(s_wav.samples, s_wav.count);
  s_stage = VP_PLAYING;
  s_at = now_ms;
}

static void next(int64_t now_ms) {
  release();
  if (++s_cur >= s_n) {
    if (!s_items[s_n - 1].id[0]) note("THE END", s_items[s_n - 1].from, now_ms);  // a story (labs)
    else note("NO MORE MESSAGES", NULL, now_ms);
    return;
  }
  play_current(now_ms);
}

bool vmplay_key(int key, int64_t now_ms) {
  if (s_stage == VP_IDLE) return false;
  if (key == 11) {  // BACK: stop
    vmplay_stop();
  } else if (key == 0 && s_stage == VP_PLAYING) {  // 1: again
    audio_play(s_wav.samples, s_wav.count);
    s_at = now_ms;
  } else if (key == 1 && (s_stage == VP_PLAYING || s_stage == VP_CANT_PLAY)) {  // 2: next
    next(now_ms);
  }
  return true;
}

void vmplay_stop(void) {
  if (s_downloading) {
    // The download task still writes into the buffer: vmplay_loaded drops it.
    s_stage = VP_IDLE;
    audio_play(NULL, 0);
    return;
  }
  release();
  s_stage = VP_IDLE;
}

void vmplay_tick(int64_t now_ms) {
  switch (s_stage) {
    case VP_FETCHING:
      if (now_ms - s_at > FETCH_TIMEOUT_MS) note("COULDN'T GET", "VOICEMAIL", now_ms);
      break;
    case VP_PLAYING:
      if (audio_played() >= s_wav.count) {
        ESP_LOGI(TAG, "played %u samples", (unsigned)s_wav.count);
        if (s_items[s_cur].id[0]) send_simple("voicemail.heard", s_items[s_cur].id);  // heard
        next(now_ms);
      }
      break;
    case VP_CANT_PLAY:
      if (now_ms - s_at > CANT_PLAY_MS) next(now_ms);
      break;
    case VP_NOTE:
      if (now_ms - s_at > NOTE_MS) s_stage = VP_IDLE;
      break;
    default:
      break;
  }
}

static void mmss(char *buf, size_t n, long ms) {
  long s = ms / 1000;
  snprintf(buf, n, "%02ld:%02ld", s / 60, s % 60);
}

int vmplay_lines(char out[6][25], int64_t now_ms) {
  char a[12], b[12];
  switch (s_stage) {
    case VP_FETCHING:
      snprintf(out[0], 25, "VOICEMAIL");
      snprintf(out[1], 25, "ONE MOMENT");
      return 2;
    case VP_NOTE:
      snprintf(out[0], 25, "%s", s_note[0]);
      snprintf(out[1], 25, "%s", s_note[1]);
      return s_note[1][0] ? 2 : 1;
    case VP_LOADING:
    case VP_PLAYING:
    case VP_CANT_PLAY: {
      item_t *it = &s_items[s_cur];
      if (it->id[0]) snprintf(out[0], 25, "MESSAGE %d OF %d", s_cur + 1, s_n);
      else snprintf(out[0], 25, "NOW PLAYING");     // a story (labs)
      snprintf(out[1], 25, "%.20s", it->from[0] ? it->from : "SOMEONE");
      if (s_stage == VP_LOADING) {
        snprintf(out[2], 25, "LOADING");
        return 3;
      }
      if (s_stage == VP_CANT_PLAY) {
        snprintf(out[2], 25, "PLAY IN APP");
        snprintf(out[3], 25, "2 NEXT");
        return 4;
      }
      // The clock moves in whole seconds so the e-paper isn't refreshed more often.
      mmss(a, sizeof a, (long)(audio_played() * 1000 / RATE));
      mmss(b, sizeof b, (long)(s_wav.count * 1000 / RATE));
      snprintf(out[2], 25, "%.8s OF %.8s", a, b);
      snprintf(out[3], 25, "1 AGAIN 2 NEXT");
      return 4;
    }
    default:
      return 0;
  }
}
