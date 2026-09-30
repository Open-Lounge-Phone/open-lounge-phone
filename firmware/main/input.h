#pragma once
#include <stdbool.h>

/** Debounced keys, hook and jack detect: posts EV_KEY (on press), EV_HOOK and EV_JACK. */
void input_start(void);
/** Current debounced hook state (true = handset up). */
bool input_hook_up(void);
/**
 * Power-on check (before input_start): how long MENU and BACK are held together (0 if not).
 * Calls `progress` about every 50 ms while they are.
 */
int input_boot_hold_ms(void (*progress)(int held_ms));
