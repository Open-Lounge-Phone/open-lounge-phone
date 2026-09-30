// Keys, hook and jack detect: GPIO interrupts wake a small task that samples every pin twice
// (DEBOUNCE_MS apart) and reports changes that stayed put; a 50 ms poll is the safety net.
#include "input.h"

#include "app.h"
#include "board.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "input";
static const int KEY_PIN[KEY_COUNT] = KEY_PINS;
static const char *const KEY_NAME[KEY_COUNT] = KEY_NAMES;
#define DEBOUNCE_MS 8
#define N_PINS (KEY_COUNT + 2)  // keys, hook, jack

static TaskHandle_t s_task;
static bool s_level[N_PINS];  // debounced raw levels (true = high)
static volatile bool s_hook_up;

static int pin_at(int i) { return i < KEY_COUNT ? KEY_PIN[i] : i == KEY_COUNT ? PIN_HOOK : PIN_JACK_DET; }

static void IRAM_ATTR isr(void *arg) {
  BaseType_t woken = pdFALSE;
  vTaskNotifyGiveFromISR(s_task, &woken);
  portYIELD_FROM_ISR(woken);
}

static void report(int i, bool high) {
  if (i < KEY_COUNT) {
    if (!high) {  // active low: pressed
      ESP_LOGI(TAG, "KEY %s", KEY_NAME[i]);
      app_post(EV_KEY, i, NULL);
    }
  } else if (i == KEY_COUNT) {
    s_hook_up = high;  // low = on the hook
    ESP_LOGI(TAG, "HOOK %s", high ? "up" : "down");
    app_post(EV_HOOK, high, NULL);
  } else {
    ESP_LOGI(TAG, "JACK %s", high ? "in" : "out");
    app_post(EV_JACK, high, NULL);
  }
}

static void task(void *arg) {
  bool first[N_PINS];
  for (;;) {
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(50));
    for (int i = 0; i < N_PINS; i++) first[i] = gpio_get_level(pin_at(i));
    vTaskDelay(pdMS_TO_TICKS(DEBOUNCE_MS));
    for (int i = 0; i < N_PINS; i++) {
      bool now = gpio_get_level(pin_at(i));
      if (now == first[i] && now != s_level[i]) {
        s_level[i] = now;
        report(i, now);
      }
    }
  }
}

bool input_hook_up(void) { return s_hook_up; }

void input_start(void) {
  uint64_t mask = 0;
  for (int i = 0; i < N_PINS; i++) mask |= 1ULL << pin_at(i);
  gpio_config_t cfg = {
      .pin_bit_mask = mask,
      .mode = GPIO_MODE_INPUT,
      .pull_up_en = GPIO_PULLUP_ENABLE,
      .intr_type = GPIO_INTR_ANYEDGE,
  };
  ESP_ERROR_CHECK(gpio_config(&cfg));
  for (int i = 0; i < N_PINS; i++) s_level[i] = gpio_get_level(pin_at(i));
  // Keys held at boot don't count as presses; the hook and jack report their start state.
  s_level[KEY_COUNT] = !s_level[KEY_COUNT];
  s_level[KEY_COUNT + 1] = !s_level[KEY_COUNT + 1];
  xTaskCreate(task, "input", 3072, NULL, 6, &s_task);
  ESP_ERROR_CHECK(gpio_install_isr_service(0));
  for (int i = 0; i < N_PINS; i++) gpio_isr_handler_add(pin_at(i), isr, NULL);
  xTaskNotifyGive(s_task);
}
