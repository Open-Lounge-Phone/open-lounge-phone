#include "snake.h"

#include "sdkconfig.h"

#if CONFIG_OLP_SNAKE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "display.h"
#include "gfx.h"
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
typedef enum { G_MENU, G_SNAKE, G_MEMORY } game_t;
static game_t s_game;

// Memory: the phone shows a growing row of digits one at a time, you key them back.
#define MEM_MAX 32
#define MEM_SHOW_MS 1100  // per digit; e-paper needs ~0.5 s to draw it
static uint8_t s_seq[MEM_MAX];  // key indexes 0-9 (digits 1-9, 0)
static int s_mlen, s_mpos, s_mbest;
static bool s_mshowing;
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

static void fill(int x0, int y0, int w, int h) { gfx_rect(s_fb, s_w, s_h, x0, y0, w, h, true); }

static void draw(void) {
  int ox = (s_w - s_cols * CELL) / 2, oy = (s_h - s_rows * CELL) / 2;
  memset(s_fb, 0, (size_t)(s_w * s_h + 7) / 8);
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
  if (!s_fb) s_fb = calloc(1, (size_t)(s_w * s_h + 7) / 8);
  s_cols = (s_w - 6) / CELL;
  s_rows = (s_h - 6) / CELL;
  s_len = 3;
  for (int i = 0; i < s_len; i++) s_body[i] = (pt_t){(int8_t)(s_cols / 2 - i), (int8_t)(s_rows / 2)};
  s_dir = s_next = (pt_t){1, 0};
  s_score = 0;
  s_period = 600;
  s_alive = true;
  s_on = true;
  s_game = G_SNAKE;
  s_last = now;
  place_food();
  ESP_LOGI(TAG, "start (%d x %d)", s_cols, s_rows);
  draw();
}

static char digit_of(int index) { return index == 9 ? '0' : (char)('1' + index); }

static void show_games(void) {
  s_game = G_MENU;
  s_alive = false;
  char best[25];
  snprintf(best, sizeof best, "BEST MEMORY %d", s_mbest);
  const char *lines[] = {"GAMES", "1 SNAKE  2 MEMORY", s_mbest ? best : "BACK: EXIT"};
  display_pixels(NULL);
  display_text(lines, 3);
  ESP_LOGI(TAG, "games menu");
}

static void memory_show(int64_t now) {
  char a[25], b[8];
  snprintf(a, sizeof a, "WATCH  %d OF %d", s_mpos + 1, s_mlen);
  snprintf(b, sizeof b, "%c", digit_of(s_seq[s_mpos]));
  const char *lines[] = {a, b};
  display_text(lines, 2);
  signals_beep(BEEP_KEY);
  ESP_LOGI(TAG, "memory watch %d of %d: %s", s_mpos + 1, s_mlen, b);
  s_last = now;
}

static void memory_round(int64_t now) {
  if (s_mlen < MEM_MAX) s_seq[s_mlen++] = (uint8_t)(esp_random() % 10);
  s_mpos = 0;
  s_mshowing = true;
  memory_show(now);
}

static void memory_start(int64_t now) {
  s_game = G_MEMORY;
  s_alive = true;
  s_mlen = 0;
  display_pixels(NULL);
  ESP_LOGI(TAG, "memory start");
  memory_round(now);
}

static void memory_key(int index, int64_t now) {
  if (s_mshowing || index > 9) return;
  if (index != s_seq[s_mpos]) {
    s_alive = false;
    int got = s_mlen - 1;
    if (got > s_mbest) s_mbest = got;
    signals_beep(BEEP_ERROR);
    char a[25], b[40];
    snprintf(a, sizeof a, "IT WAS %c", digit_of(s_seq[s_mpos]));
    snprintf(b, sizeof b, "SCORE %d  BEST %d", got, s_mbest);
    const char *lines[] = {"GAME OVER", a, b, "MENU: AGAIN"};
    display_text(lines, 4);
    ESP_LOGI(TAG, "memory over, score %d", got);
    return;
  }
  if (++s_mpos < s_mlen) return;
  signals_beep(BEEP_OK);
  const char *lines[] = {"RIGHT!", "NEXT ROUND"};
  display_text(lines, 2);
  ESP_LOGI(TAG, "memory round %d right", s_mlen);
  s_mshowing = true;
  s_mpos = -1;  // the tick starts the next round after a pause
  s_last = now;
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
  s_on = true;
  show_games();
  return true;
}

bool snake_key(int index, int64_t now) {
  if (!s_on) return false;
  if (s_game == G_MENU) {
    if (index == 11) snake_stop();  // BACK leaves the games menu
    else if (index == 0) start_game(now);
    else if (index == 1) memory_start(now);
    return true;
  }
  if (index == 11) {  // BACK: back to the games menu
    show_games();
    return true;
  }
  if (!s_alive) {
    if (index == 10) s_game == G_SNAKE ? start_game(now) : memory_start(now);
    return true;
  }
  if (s_game == G_MEMORY) {
    memory_key(index, now);
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
  if (!s_on || !s_alive) return;
  if (s_game == G_MEMORY) {
    if (!s_mshowing || now - s_last < MEM_SHOW_MS) return;
    if (s_mpos < 0) {
      memory_round(now);
    } else if (++s_mpos < s_mlen) {
      memory_show(now);
    } else {
      s_mshowing = false;
      s_mpos = 0;
      const char *lines[] = {"YOUR TURN", "KEY THEM BACK"};
      display_text(lines, 2);
      ESP_LOGI(TAG, "memory your turn");
    }
    return;
  }
  if (s_game != G_SNAKE || now - s_last < s_period) return;
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
  ESP_LOGI(TAG, "move %d,%d len %d", head.x, head.y, s_len);
  draw();
}

void snake_stop(void) {
  if (!s_on) return;
  s_on = false;
  s_alive = false;
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
