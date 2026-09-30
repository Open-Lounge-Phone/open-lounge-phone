// Display task: renders the latest text in the background (an e-paper refresh blocks for
// seconds). Text that didn't change isn't redrawn.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "display.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "gfx.h"

static const char *TAG = "display";
#define MAX_LINES 4
#define FULL_EVERY 20  // a full refresh every N updates clears e-paper ghosting

static const display_driver_t *s_drv;
static SemaphoreHandle_t s_lock;
static TaskHandle_t s_task;
static char s_want[MAX_LINES][25];
static int s_want_n = -1;
static uint8_t *s_fb;

static void task(void *arg) {
  char shown[MAX_LINES][25];
  int shown_n = -1, updates = 0;
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    char lines[MAX_LINES][25];
    xSemaphoreTake(s_lock, portMAX_DELAY);
    int n = s_want_n;
    memcpy(lines, s_want, sizeof lines);
    xSemaphoreGive(s_lock);
    if (n == shown_n && !memcmp(lines, shown, sizeof lines)) continue;
    const char *ptrs[MAX_LINES] = {lines[0], lines[1], lines[2], lines[3]};
    gfx_render_lines(s_fb, s_drv->width, s_drv->height, ptrs, n);
    bool full = updates++ % FULL_EVERY == 0;
    s_drv->flush(s_fb, full);
    memcpy(shown, lines, sizeof shown);
    shown_n = n;
  }
}

void display_start(const display_driver_t *drv) {
  s_drv = drv;
  s_lock = xSemaphoreCreateMutex();
  s_fb = calloc(1, (size_t)(drv->width * drv->height + 7) / 8);
  if (drv->init() != ESP_OK) ESP_LOGW(TAG, "%s: init failed (not fitted?)", drv->name);
  xTaskCreate(task, "display", 4096, NULL, 3, &s_task);
}

void display_text(const char *const *lines, int n) {
  if (!s_task) return;
  if (n > MAX_LINES) n = MAX_LINES;
  xSemaphoreTake(s_lock, portMAX_DELAY);
  memset(s_want, 0, sizeof s_want);
  for (int i = 0; i < n; i++) strncpy(s_want[i], lines[i], 24);
  s_want_n = n;
  xSemaphoreGive(s_lock);
  xTaskNotifyGive(s_task);
}

void display_dump(void) {
  if (!s_fb) return;
  int w = s_drv->width, h = s_drv->height, row = (w + 7) / 8;
  char *line = malloc(8 + row * 2 + 2);
  if (!line) return;
  printf("FB %d %d\n", w, h);
  for (int y = 0; y < h; y++) {
    // Rows are w bits each, packed back to back; print them byte-aligned, one printf per row so
    // other tasks' log lines can't split a row.
    int n = sprintf(line, "FBROW ");
    for (int b = 0; b < row; b++) {
      uint8_t v = 0;
      for (int k = 0; k < 8; k++) {
        int x = b * 8 + k;
        int bit = y * w + x;
        if (x < w && (s_fb[bit / 8] & (0x80 >> (bit % 8)))) v |= 0x80 >> k;
      }
      n += sprintf(line + n, "%02x", v);
    }
    printf("%s\n", line);
  }
  printf("FB END\n");
  free(line);
}
