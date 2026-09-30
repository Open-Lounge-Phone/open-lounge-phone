#pragma once
#include <stdbool.h>

/** Debounced keys, hook and jack detect: posts EV_KEY (on press), EV_HOOK and EV_JACK. */
void input_start(void);
/** Current debounced hook state (true = handset up). */
bool input_hook_up(void);
