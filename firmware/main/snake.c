#include "snake.h"

#include "sdkconfig.h"

#if CONFIG_OLP_SNAKE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "display.h"
#include "esp_log.h"
#include "esp_random.h"
#include "signals.h"

static const char *TAG = "snake";
#define CELL 10
#define MAX_LEN 400
#define TRIGGER 10
#define GAP_MS 1500  // presses in a row, none more than this apart

typedef struct { int8_t x, y; } pt_t;
static bool s_on, s_alive;
static pt_t s_body[MAX_LEN];  // head first
static int s_len, s_score, s_cols, s_rows, s_period;
static pt_t s_dir, s_next, s_food;
static int64_t s_last, s_presses[TRIGGER];
static int s_pi;
static uint8_t *s_fb;
static int s_w, s_h;

static bool on_body(pt_t p, int from) {
  for (int i = from; i < s_len; i++)
    if (s_body[i].x == p.x && s_body[i].y == p.y) return true;
  return false;
}

static void place_food(void) {
  do {
    s_food.x = (int8_t)(esp_random() % s_cols);
    s_food.y = (int8_t)(esp_random() % s_rows);
  } while (on_body(s_food, 0));
}

static void fill(int x0, int y0, int w, int h) {
  int row = (s_w + 7) / 8;
  for (int y = y0; y < y0 + h && y < s_h; y++)
    for (int x = x0; x < x0 + w && x < s_w; x++) s_fb[y * row + x / 8] |= 0x80 >> (x % 8);
}

static void draw(void) {
  int ox = (s_w - s_cols * CELL) / 2, oy = (s_h - s_rows * CELL) / 2;
  memset(s_fb, 0, (size_t)((s_w + 7) / 8) * s_h);
  fill(ox - 2, oy - 2, s_cols * CELL + 4, 1);                  // a thin frame
  fill(ox - 2, oy + s_rows * CELL + 1, s_cols * CELL + 4, 1);
  fill(ox - 2, oy - 2, 1, s_rows * CELL + 4);
  fill(ox + s_cols * CELL + 1, oy - 2, 1, s_rows * CELL + 4);
  for (int i = 0; i < s_len; i++) fill(ox + s_body[i].x * CELL + 1, oy + s_body[i].y * CELL + 1, CELL - 2, CELL - 2);
  int fx = ox + s_food.x * CELL, fy = oy + s_food.y * CELL;   // food: a small diamond
  fill(fx + 4, fy + 2, 2, 6);
  fill(fx + 2, fy + 4, 6, 2);
  display_pixels(s_fb);
}

static void start_game(int64_t now) {
  display_size(&s_w, &s_h);
  if (!s_fb) s_fb = calloc(1, (size_t)((s_w + 7) / 8) * s_h);
  s_cols = (s_w - 6) / CELL;
  s_rows = (s_h - 6) / CELL;
  s_len = 3;
  for (int i = 0; i < s_len; i++) s_body[i] = (pt_t){(int8_t)(s_cols / 2 - i), (int8_t)(s_rows / 2)};
  s_dir = s_next = (pt_t){1, 0};
  s_score = 0;
  s_period = 600;
  s_alive = true;
  s_on = true;
  s_last = now;
  place_food();
  ESP_LOGI(TAG, "start (%d x %d)", s_cols, s_rows);
  draw();
}

static void game_over(void) {
  s_alive = false;
  signals_beep(BEEP_ERROR);
  char score[25];
  snprintf(score, sizeof score, "SCORE %d", s_score);
  const char *lines[] = {"GAME OVER", score, "MENU: AGAIN", "BACK: EXIT"};
  display_pixels(NULL);
  display_text(lines, 4);
  ESP_LOGI(TAG, "game over, score %d", s_score);
}

bool snake_menu_press(int64_t now) {
  if (s_on) return false;
  s_pi = (s_presses[0] && now - s_presses[0] <= GAP_MS) ? s_pi + 1 : 1;
  s_presses[0] = now;
  ESP_LOGD(TAG, "menu press %d/%d", s_pi, TRIGGER);
  if (s_pi < TRIGGER) return false;
  s_pi = 0;
  s_presses[0] = 0;
  start_game(now);
  return true;
}

bool snake_key(int index, int64_t now) {
  if (!s_on) return false;
  if (index == 11) {  // BACK
    snake_stop();
    return true;
  }
  if (!s_alive) {
    if (index == 10) start_game(now);
    return true;
  }
  pt_t want = s_dir;
  if (index == 2) want = (pt_t){0, -1};       // 3: up
  else if (index == 7) want = (pt_t){0, 1};   // 8: down
  else if (index == 6) want = (pt_t){-1, 0};  // 7: left
  else if (index == 8) want = (pt_t){1, 0};   // 9: right
  if (want.x != -s_dir.x || want.y != -s_dir.y) s_next = want;  // no turning back on itself
  return true;
}

void snake_tick(int64_t now) {
  if (!s_on || !s_alive || now - s_last < s_period) return;
  s_last = now;
  s_dir = s_next;
  pt_t head = {(int8_t)(s_body[0].x + s_dir.x), (int8_t)(s_body[0].y + s_dir.y)};
  bool eat = head.x == s_food.x && head.y == s_food.y;
  if (head.x < 0 || head.y < 0 || head.x >= s_cols || head.y >= s_rows || on_body(head, eat ? 0 : 1)) {
    game_over();
    return;
  }
  if (eat && s_len < MAX_LEN) s_len++;
  memmove(&s_body[1], &s_body[0], sizeof(pt_t) * (size_t)(s_len - 1));
  s_body[0] = head;
  if (eat) {
    s_score++;
    signals_beep(BEEP_OK);
    if (s_period > 450) s_period -= 15;  // e-paper sets the pace: a refresh takes ~0.5 s
    place_food();
  }
  draw();
}

void snake_stop(void) {
  if (!s_on) return;
  s_on = false;
  display_pixels(NULL);
  ESP_LOGI(TAG, "stop");
}

bool snake_active(void) { return s_on; }

#else
bool snake_menu_press(int64_t now_ms) { return false; }
bool snake_key(int index, int64_t now_ms) { return false; }
void snake_tick(int64_t now_ms) {}
void snake_stop(void) {}
bool snake_active(void) { return false; }
#endif
