// The piezo ringer (LEDC PWM) and the status LED (LEDC PWM, so it can breathe).
#pragma once
#include <stdbool.h>

typedef enum {
  LED_OFF,
  LED_DIM,       // idle and online
  LED_ON,        // in a call (and the recording light)
  LED_PULSE,     // pairing / connecting
  LED_BLINK,     // offline (slow)
  LED_RINGING,   // incoming call (fast)
  LED_BREATHE,   // missed calls / voicemail waiting
  LED_RECORDING, // double flash every second: this call or room is recorded
} led_pattern_t;

typedef enum { BEEP_KEY, BEEP_PAIR, BEEP_ERROR, BEEP_OK, BEEP_NOTICE } beep_t;

/** Ringer loudness (piezo duty) and ring cadence, saved in NVS. */
#define RING_LEVELS 3  // 1 soft, 2 medium, 3 loud
typedef enum { RING_CLASSIC, RING_DOUBLE, RING_BEEPS, RING_STYLES } ring_style_t;

void signals_start(void);
int signals_ring_level(void);
void signals_set_ring_level(int level);  // 1..RING_LEVELS
ring_style_t signals_ring_style(void);
void signals_set_ring_style(ring_style_t style);
const char *signals_ring_style_name(ring_style_t style);
/** One ring cycle (3 s) to hear the setting. */
void signals_ring_preview(void);
void signals_led(led_pattern_t p);
void signals_ring(bool on);
void signals_beep(beep_t b);
const char *signals_led_name(led_pattern_t p);
