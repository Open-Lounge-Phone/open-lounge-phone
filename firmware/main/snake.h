// Snake, a personal easter egg (CONFIG_OLP_SNAKE, off by default): press MENU ten times within
// four seconds. 3 up, 8 down, 7 left, 9 right; BACK quits; MENU starts again after a crash.
#pragma once
#include <stdbool.h>
#include <stdint.h>

/** Count a MENU press; true when it was the tenth in four seconds and the game started. */
bool snake_menu_press(int64_t now_ms);
/** While playing: take the key (protocol index 0-9, 10 MENU, 11 BACK). True if consumed. */
bool snake_key(int index, int64_t now_ms);
void snake_tick(int64_t now_ms);
void snake_stop(void);
bool snake_active(void);
