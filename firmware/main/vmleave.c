#include "vmleave.h"

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

static const char *TAG = "vm";

#define RATE 8000
#define WAV_HEADER 44
#define BEEP_MS 600

static vm_stage_t s_stage = VM_IDLE;
static char s_ticket[129];
static uint8_t *s_buf;  // WAV header + samples
static size_t s_max_samples, s_samples;
static int64_t s_stage_at;

const char *vm_stage_name(vm_stage_t s) {
  static const char *names[] = {"idle", "beep", "recording", "sending", "sent", "failed"};
  return names[s];
}

vm_stage_t vm_leave_stage(void) { return s_stage; }

static void set_stage(vm_stage_t st, int64_t now_ms) {
  s_stage = st;
  s_stage_at = now_ms;
  ESP_LOGI(TAG, "VOICEMAIL %s", vm_stage_name(st));
}

static void drop(void) {
  audio_record_stop();
  free(s_buf);
  s_buf = NULL;
}

void vm_leave_start(const char *ticket, int max_ms, int64_t now_ms) {
  if (s_stage == VM_BEEP || s_stage == VM_RECORDING || s_stage == VM_SENDING) return;
  if (!ticket || !ticket[0]) return;
  snprintf(s_ticket, sizeof s_ticket, "%s", ticket);
  if (max_ms <= 0 || max_ms > 120000) max_ms = 120000;
  s_max_samples = (size_t)max_ms * RATE / 1000;
  s_buf = heap_caps_malloc(WAV_HEADER + s_max_samples * 2, MALLOC_CAP_SPIRAM);
  if (!s_buf) {
    ESP_LOGE(TAG, "no memory for a %d ms message", max_ms);
    set_stage(VM_FAILED, now_ms);
    return;
  }
  audio_force_tone(TONE_TEST);  // the beep
  set_stage(VM_BEEP, now_ms);
}

int vm_leave_remaining_ms(int64_t now_ms) {
  if (s_stage != VM_RECORDING) return 0;
  return (int)((s_max_samples - audio_recorded()) * 1000 / RATE);
}

static void put32(uint8_t *p, uint32_t v) {
  p[0] = v;
  p[1] = v >> 8;
  p[2] = v >> 16;
  p[3] = v >> 24;
}
static void put16(uint8_t *p, uint16_t v) {
  p[0] = v;
  p[1] = v >> 8;
}

static void wav_header(uint8_t *h, size_t samples) {
  uint32_t data = (uint32_t)(samples * 2);
  memcpy(h, "RIFF", 4);
  put32(h + 4, 36 + data);
  memcpy(h + 8, "WAVEfmt ", 8);
  put32(h + 16, 16);
  put16(h + 20, 1);  // PCM
  put16(h + 22, 1);  // mono
  put32(h + 24, RATE);
  put32(h + 28, RATE * 2);
  put16(h + 32, 2);
  put16(h + 34, 16);
  memcpy(h + 36, "data", 4);
  put32(h + 40, data);
}

/** wss://host/path → https://host/path (ws → http). */
static void http_base(char *out, size_t n) {
  char url[PROV_SERVER_MAX];
  net_server_url(url, sizeof url);
  if (!strncmp(url, "wss://", 6)) snprintf(out, n, "https://%s", url + 6);
  else if (!strncmp(url, "ws://", 5)) snprintf(out, n, "http://%s", url + 5);
  else snprintf(out, n, "%s", url);
  size_t l = strlen(out);
  if (l && out[l - 1] == '/') out[l - 1] = '\0';
}

static void upload_task(void *arg) {
  char base[PROV_SERVER_MAX + 8], url[PROV_SERVER_MAX + 220];
  http_base(base, sizeof base);
  snprintf(url, sizeof url, "%s/api/vm/message?ticket=%s&durationMs=%u", base, s_ticket,
           (unsigned)(s_samples * 1000 / RATE));
  esp_http_client_config_t cfg = {
      .url = url,
      .method = HTTP_METHOD_POST,
      .crt_bundle_attach = esp_crt_bundle_attach,
      .timeout_ms = 30000,
  };
  bool ok = false;
  esp_http_client_handle_t c = esp_http_client_init(&cfg);
  if (c) {
    esp_http_client_set_header(c, "content-type", "audio/wav");
    esp_http_client_set_post_field(c, (const char *)s_buf, (int)(WAV_HEADER + s_samples * 2));
    esp_err_t err = esp_http_client_perform(c);
    int status = esp_http_client_get_status_code(c);
    ok = err == ESP_OK && status == 201;
    ESP_LOGI(TAG, "upload %u bytes: %s, HTTP %d", (unsigned)(WAV_HEADER + s_samples * 2),
             esp_err_to_name(err), status);
    esp_http_client_cleanup(c);
  }
  app_post(EV_VM_SENT, ok, NULL);
  vTaskDelete(NULL);
}

void vm_leave_finish(int64_t now_ms) {
  if (s_stage == VM_BEEP) {
    audio_force_tone(TONE_NONE);
    drop();
    set_stage(VM_IDLE, now_ms);
    return;
  }
  if (s_stage != VM_RECORDING) {
    if (s_stage == VM_FAILED) set_stage(VM_IDLE, now_ms);
    return;
  }
  s_samples = audio_record_stop();
  if (s_samples * 1000 / RATE < VM_MIN_MS) {
    ESP_LOGI(TAG, "message too short (%u ms): not sent", (unsigned)(s_samples * 1000 / RATE));
    drop();
    set_stage(VM_IDLE, now_ms);
    return;
  }
  wav_header(s_buf, s_samples);
  set_stage(VM_SENDING, now_ms);
  if (xTaskCreate(upload_task, "vm_upload", 8192, NULL, 4, NULL) != pdPASS) {
    drop();
    set_stage(VM_FAILED, now_ms);
  }
}

void vm_leave_sent(bool ok, int64_t now_ms) {
  free(s_buf);
  s_buf = NULL;
  set_stage(ok ? VM_SENT : VM_FAILED, now_ms);
}

void vm_leave_tick(int64_t now_ms) {
  if (s_stage == VM_BEEP && now_ms - s_stage_at >= BEEP_MS) {
    audio_force_tone(TONE_NONE);
    audio_record((int16_t *)(s_buf + WAV_HEADER), s_max_samples);
    set_stage(VM_RECORDING, now_ms);
  } else if (s_stage == VM_RECORDING && audio_recorded() >= s_max_samples) {
    vm_leave_finish(now_ms);  // the limit: send it now
  } else if ((s_stage == VM_SENT || s_stage == VM_FAILED) &&
             now_ms - s_stage_at >= VM_RESULT_SHOW_MS) {
    set_stage(VM_IDLE, now_ms);
  }
}
