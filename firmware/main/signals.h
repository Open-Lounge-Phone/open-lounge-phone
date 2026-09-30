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
} led_pattern_t;

typedef enum { BEEP_KEY, BEEP_PAIR, BEEP_ERROR, BEEP_OK } beep_t;

void signals_start(void);
void signals_led(led_pattern_t p);
void signals_ring(bool on);
void signals_beep(beep_t b);
const char *signals_led_name(led_pattern_t p);
