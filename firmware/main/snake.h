// Games, a personal easter egg (CONFIG_OLP_SNAKE, off by default): press MENU ten times in a row
// (no gap over 1.5 s) for the games menu: 1 Snake (3 up, 8 down, 7 left, 9 right), 2 Memory (watch
// the digits, key them back). BACK goes to the games menu, BACK again leaves; MENU plays again.
#pragma once
#include <stdbool.h>
#include <stdint.h>

/** Count a MENU press; true when it made ten in a row and the games menu opened. */
bool snake_menu_press(int64_t now_ms);
/** While playing: take the key (protocol index 0-9, 10 MENU, 11 BACK). True if consumed. */
bool snake_key(int index, int64_t now_ms);
void snake_tick(int64_t now_ms);
void snake_stop(void);
bool snake_active(void);
