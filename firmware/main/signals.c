// Ringer and status LED, both on LEDC, driven by one 10 ms esp_timer.
#include "signals.h"

#include <math.h>

#include "board.h"
#include "driver/ledc.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "nvs.h"

static const char *TAG = "signals";

#define LED_CH LEDC_CHANNEL_0
#define BUZ_CH LEDC_CHANNEL_1
#define DUTY_MAX 1023
#define BUZZER_HZ 4000  // the piezo's resonance
#define TICK_MS 10

static volatile led_pattern_t s_led = LED_OFF;
static volatile bool s_ring;
static uint32_t s_t;  // ticks since start
static volatile int s_ring_level = RING_LEVELS;
static volatile ring_style_t s_ring_style = RING_CLASSIC;
static volatile uint32_t s_preview_until, s_preview_from;  // ticks
// Piezo duty per level: a square wave is loudest at 50 %, much quieter at a few percent.
static const uint32_t RING_DUTY[RING_LEVELS + 1] = {0, DUTY_MAX / 25, DUTY_MAX / 8, DUTY_MAX / 2};

// A beep is a list of on/off durations in ticks, 0-terminated.
static const uint8_t BEEPS[][8] = {
    [BEEP_KEY] = {3, 0},
    [BEEP_PAIR] = {12, 8, 12, 8, 12, 0},
    [BEEP_ERROR] = {40, 0},
    [BEEP_OK] = {6, 6, 6, 0},
    [BEEP_NOTICE] = {20, 10, 20, 30, 40, 0},  // a notice from the space: short, short, long
};
static volatile int s_beep = -1;
static int s_beep_step;
static uint32_t s_beep_left;

const char *signals_led_name(led_pattern_t p) {
  static const char *names[] = {"off", "dim", "on", "pulse", "blink", "ringing", "breathe", "recording"};
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
    case LED_RECORDING: {
      uint32_t p = ms % 1000;
      return (p < 80 || (p >= 200 && p < 280)) ? DUTY_MAX : 0;
    }
    case LED_BREATHE: {
      float x = (1.0f - cosf((float)(ms % 4000) / 4000.0f * 2.0f * (float)M_PI)) / 2.0f;
      return (uint32_t)(x * x * DUTY_MAX);
    }
  }
  return 0;
}

/**
 * Ring cadences, 3 s each. Classic: 1 s of warble (the tone switched at 25 Hz), 2 s of silence.
 * Double: two 0.4 s warbles 0.2 s apart. Beeps: three 0.15 s beeps.
 */
static bool ring_on(uint32_t t) {
  uint32_t ms = (t * TICK_MS) % 3000;
  bool warble = (ms / 20) % 2 == 0;
  switch (s_ring_style) {
    case RING_DOUBLE: return (ms < 400 || (ms >= 600 && ms < 1000)) && warble;
    case RING_BEEPS: return ms < 750 && (ms % 250) < 150;
    default: return ms < 1000 && warble;
  }
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
  }
  uint32_t duty = DUTY_MAX / 2;  // beeps: always the same
  if (s_beep < 0 && (s_ring || s_t < s_preview_until)) {
    tone = ring_on(s_ring ? s_t : s_t - s_preview_from);
    duty = RING_DUTY[s_ring_level];
  }
  ledc_set_duty(LEDC_LOW_SPEED_MODE, BUZ_CH, tone ? duty : 0);
  ledc_update_duty(LEDC_LOW_SPEED_MODE, BUZ_CH);
}

static void load_settings(void) {
  nvs_handle_t h;
  if (nvs_open("olp", NVS_READONLY, &h) != ESP_OK) return;
  uint8_t v;
  if (nvs_get_u8(h, "ring_level", &v) == ESP_OK && v >= 1 && v <= RING_LEVELS) s_ring_level = v;
  if (nvs_get_u8(h, "ring_style", &v) == ESP_OK && v < RING_STYLES) s_ring_style = v;
  nvs_close(h);
}

static void save_u8(const char *key, uint8_t v) {
  nvs_handle_t h;
  if (nvs_open("olp", NVS_READWRITE, &h) != ESP_OK) return;
  nvs_set_u8(h, key, v);
  nvs_commit(h);
  nvs_close(h);
}

int signals_ring_level(void) { return s_ring_level; }
ring_style_t signals_ring_style(void) { return s_ring_style; }

const char *signals_ring_style_name(ring_style_t style) {
  static const char *names[] = {"CLASSIC", "DOUBLE", "BEEPS"};
  return style < RING_STYLES ? names[style] : "?";
}

void signals_set_ring_level(int level) {
  if (level < 1) level = 1;
  if (level > RING_LEVELS) level = RING_LEVELS;
  s_ring_level = level;
  save_u8("ring_level", (uint8_t)level);
}

void signals_set_ring_style(ring_style_t style) {
  if (style >= RING_STYLES) style = RING_CLASSIC;
  s_ring_style = style;
  save_u8("ring_style", (uint8_t)style);
}

void signals_ring_preview(void) {
  s_preview_from = s_t;
  s_preview_until = s_t + 1500 / TICK_MS;  // the ringing part of one cycle
}

void signals_start(void) {
  load_settings();
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
