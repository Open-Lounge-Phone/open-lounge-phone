// Ringer and status LED, both on LEDC, driven by one 10 ms esp_timer.
#include "signals.h"

#include <math.h>

#include "board.h"
#include "driver/ledc.h"
#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "signals";

#define LED_CH LEDC_CHANNEL_0
#define BUZ_CH LEDC_CHANNEL_1
#define DUTY_MAX 1023
#define BUZZER_HZ 4000  // the piezo's resonance
#define TICK_MS 10

static volatile led_pattern_t s_led = LED_OFF;
static volatile bool s_ring;
static uint32_t s_t;  // ticks since start

// A beep is a list of on/off durations in ticks, 0-terminated.
static const uint8_t BEEPS[][8] = {
    [BEEP_KEY] = {3, 0},
    [BEEP_PAIR] = {12, 8, 12, 8, 12, 0},
    [BEEP_ERROR] = {40, 0},
    [BEEP_OK] = {6, 6, 6, 0},
};
static volatile int s_beep = -1;
static int s_beep_step;
static uint32_t s_beep_left;

const char *signals_led_name(led_pattern_t p) {
  static const char *names[] = {"off", "dim", "on", "pulse", "blink", "ringing", "breathe"};
  return names[p];
}

static uint32_t led_duty(uint32_t t) {
  uint32_t ms = t * TICK_MS;
  switch (s_led) {
    case LED_OFF: return 0;
    case LED_DIM: return DUTY_MAX / 12;
    case LED_ON: return DUTY_MAX;
    case LED_PULSE: return (ms % 1000) < 500 ? (ms % 500) * DUTY_MAX / 500 : 0;
    case LED_BLINK: return (ms % 2000) < 100 ? DUTY_MAX : 0;
    case LED_RINGING: return (ms % 250) < 125 ? DUTY_MAX : 0;
    case LED_BREATHE: {
      float x = (1.0f - cosf((float)(ms % 4000) / 4000.0f * 2.0f * (float)M_PI)) / 2.0f;
      return (uint32_t)(x * x * DUTY_MAX);
    }
  }
  return 0;
}

/** Ring cadence: 1 s of warble (the tone switched at 25 Hz), 2 s of silence. */
static bool ring_on(uint32_t t) {
  uint32_t ms = (t * TICK_MS) % 3000;
  return ms < 1000 && (ms / 20) % 2 == 0;
}

static void tick(void *arg) {
  s_t++;
  ledc_set_duty(LEDC_LOW_SPEED_MODE, LED_CH, led_duty(s_t));
  ledc_update_duty(LEDC_LOW_SPEED_MODE, LED_CH);

  bool tone = false;
  if (s_beep >= 0) {
    if (s_beep_left == 0) {
      uint8_t d = BEEPS[s_beep][s_beep_step];
      if (d == 0 || s_beep_step >= 8) {
        s_beep = -1;
      } else {
        s_beep_left = d;
        s_beep_step++;
      }
    }
    if (s_beep >= 0) {
      tone = (s_beep_step % 2) == 1;  // odd steps are "on"
      s_beep_left--;
    }
  } else if (s_ring) {
    tone = ring_on(s_t);
  }
  ledc_set_duty(LEDC_LOW_SPEED_MODE, BUZ_CH, tone ? DUTY_MAX / 2 : 0);
  ledc_update_duty(LEDC_LOW_SPEED_MODE, BUZ_CH);
}

void signals_start(void) {
  ledc_timer_config_t led_timer = {
      .speed_mode = LEDC_LOW_SPEED_MODE,
      .duty_resolution = LEDC_TIMER_10_BIT,
      .timer_num = LEDC_TIMER_0,
      .freq_hz = 5000,
      .clk_cfg = LEDC_AUTO_CLK,
  };
  ESP_ERROR_CHECK(ledc_timer_config(&led_timer));
  ledc_timer_config_t buz_timer = led_timer;
  buz_timer.timer_num = LEDC_TIMER_1;
  buz_timer.freq_hz = BUZZER_HZ;
  ESP_ERROR_CHECK(ledc_timer_config(&buz_timer));
  ledc_channel_config_t led = {
      .gpio_num = PIN_STATUS_LED,
      .speed_mode = LEDC_LOW_SPEED_MODE,
      .channel = LED_CH,
      .timer_sel = LEDC_TIMER_0,
      .duty = 0,
  };
  ESP_ERROR_CHECK(ledc_channel_config(&led));
  ledc_channel_config_t buz = led;
  buz.gpio_num = PIN_BUZZER;
  buz.channel = BUZ_CH;
  buz.timer_sel = LEDC_TIMER_1;
  ESP_ERROR_CHECK(ledc_channel_config(&buz));

  const esp_timer_create_args_t args = {.callback = tick, .name = "signals"};
  esp_timer_handle_t timer;
  ESP_ERROR_CHECK(esp_timer_create(&args, &timer));
  ESP_ERROR_CHECK(esp_timer_start_periodic(timer, TICK_MS * 1000));
}

void signals_led(led_pattern_t p) {
  if (p == s_led) return;
  s_led = p;
  ESP_LOGI(TAG, "SIG led=%s", signals_led_name(p));
}

void signals_ring(bool on) {
  if (on == s_ring) return;
  s_ring = on;
  ESP_LOGI(TAG, "SIG ring=%s", on ? "on" : "off");
}

void signals_beep(beep_t b) {
  s_beep_step = 0;
  s_beep_left = 0;
  s_beep = b;
}
