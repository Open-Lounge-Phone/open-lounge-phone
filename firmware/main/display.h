// A tiny display interface: a 1-bit landscape framebuffer and a driver that shows it. The
// standard module is the WeAct 2.9" e-paper (SSD1680); an OLED/TFT driver only has to fill in
// another display_driver_t.
#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

typedef struct {
  const char *name;
  int width, height;  // landscape pixels
  esp_err_t (*init)(void);
  /** Show `fb` (width*height bits, row-major, MSB first, 1 = black). `full` = full refresh. */
  void (*flush)(const uint8_t *fb, bool full);
} display_driver_t;

extern const display_driver_t display_epd_ssd1680;
extern const display_driver_t display_ili9341_sim;  // the Wokwi stand-in

/** Starts the display task (renders the latest text in the background). */
void display_start(const display_driver_t *drv);
/** Show up to 4 lines of text (≤ 2 lines use large type, as the protocol's strip model). */
void display_text(const char *const *lines, int n);
/** Print the last rendered framebuffer on the console ("FB w h" + one hex line per row). */
void display_dump(void);
