// USB keyboard combos for the macro pad (labs): "ctrl+shift+m", "f13", "alt+tab", "mute",
// "play", "volup". Keyboard keys are HID usage page 0x07; media keys page 0x0C. Pure.
#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef struct {
  uint8_t modifiers;  // bit 0 ctrl, 1 shift, 2 alt, 3 gui (left side)
  uint8_t key;        // keyboard usage (0 = none)
  uint16_t media;     // consumer usage (0 = none)
} hid_combo_t;

bool hid_parse(const char *combo, hid_combo_t *out);
