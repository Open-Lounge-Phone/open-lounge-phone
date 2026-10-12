// WeAct Studio 2.9" e-paper module (296 x 128, SSD1680) on SPI + DC/RST/BUSY. Command
// sequence as in GxEPD2_290_T94 / the Waveshare 2.9" V2 driver (the same controller).
// Full refresh (0x22 0xF7) every FULL_EVERY updates, fast partial refresh (0x22 0xFC, the
// controller's built-in waveform) in between. TODO: confirm the partial mode on a real panel.
#include <stdio.h>
#include <string.h>

#include "sdkconfig.h"

#include "board.h"
#include "display.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "epd";
#define NATIVE_W 128  // source lines in RAM (x)
#if CONFIG_OLP_EPD_213
#define VIS_W 122     // the 2.13" panel shows 122 of them
#define NATIVE_H 250  // gate lines (y)
#define EPD_NAME "WeAct 2.13\" e-paper (SSD1680)"
#else
#define VIS_W 128
#define NATIVE_H 296
#define EPD_NAME "WeAct 2.9\" e-paper (SSD1680)"
#endif
#define ROW_BYTES (NATIVE_W / 8)
#define LAND_W NATIVE_H
#define LAND_H VIS_W

static spi_device_handle_t s_spi;
static uint8_t s_ram[ROW_BYTES * NATIVE_H];

static bool s_fitted;

/** Waits while BUSY is high. Returns false on a timeout. */
static bool wait_busy(const char *what, int timeout_ms) {
  int t = 0;
  while (gpio_get_level(PIN_EPD_BUSY) == 1) {  // high = busy
    vTaskDelay(pdMS_TO_TICKS(5));
    if ((t += 5) > timeout_ms) {
      ESP_LOGW(TAG, "busy timeout (%s)", what);
      return false;
    }
  }
  return true;
}

static void xfer(bool data, const uint8_t *buf, size_t len) {
  gpio_set_level(PIN_EPD_DC, data);
  while (len > 0) {
    size_t n = len > 4000 ? 4000 : len;
    spi_transaction_t tx = {.length = n * 8, .tx_buffer = buf};
    spi_device_polling_transmit(s_spi, &tx);
    buf += n;
    len -= n;
  }
}

static void cmd(uint8_t c, const uint8_t *data, size_t len) {
  xfer(false, &c, 1);
  if (len) xfer(true, data, len);
}
#define CMD(c, ...)                                   \
  do {                                                \
    const uint8_t d_[] = {__VA_ARGS__};               \
    cmd((c), d_, sizeof d_);                          \
  } while (0)

static bool panel_init(void) {
  gpio_set_level(PIN_EPD_RST, 0);
  vTaskDelay(pdMS_TO_TICKS(10));
  gpio_set_level(PIN_EPD_RST, 1);
  vTaskDelay(pdMS_TO_TICKS(10));
  if (!wait_busy("reset", 1000)) return false;  // BUSY stuck high: no module
  cmd(0x12, NULL, 0);  // software reset
  wait_busy("swreset", 2000);
  CMD(0x01, (NATIVE_H - 1) & 0xFF, (NATIVE_H - 1) >> 8, 0x00);  // driver output: the gate lines
  CMD(0x11, 0x03);                                              // data entry: x+, y+
  CMD(0x44, 0x00, ROW_BYTES - 1);                               // RAM x window (bytes)
  CMD(0x45, 0x00, 0x00, (NATIVE_H - 1) & 0xFF, (NATIVE_H - 1) >> 8);  // RAM y window
  CMD(0x3C, 0x05);                                              // border waveform
  CMD(0x21, 0x00, 0x80);                                        // display update control 1
  CMD(0x18, 0x80);                                              // internal temperature sensor
  wait_busy("init", 2000);
  return true;
}

static void write_ram(uint8_t reg) {
  CMD(0x4E, 0x00);
  CMD(0x4F, 0x00, 0x00);
  cmd(reg, s_ram, sizeof s_ram);
}

static esp_err_t epd_init(void) {
  gpio_config_t out = {.pin_bit_mask = (1ULL << PIN_EPD_DC) | (1ULL << PIN_EPD_RST),
                       .mode = GPIO_MODE_OUTPUT};
  gpio_config(&out);
  // The module drives BUSY; the pull-down makes a missing module read "not busy" at once.
  gpio_config_t in = {.pin_bit_mask = 1ULL << PIN_EPD_BUSY,
                      .mode = GPIO_MODE_INPUT,
                      .pull_down_en = GPIO_PULLDOWN_ENABLE};
  gpio_config(&in);
  spi_bus_config_t bus = {
      .mosi_io_num = PIN_EPD_DIN,
      .miso_io_num = -1,
      .sclk_io_num = PIN_EPD_CLK,
      .quadwp_io_num = -1,
      .quadhd_io_num = -1,
      .max_transfer_sz = 4096,
  };
  esp_err_t err = spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO);
  if (err != ESP_OK) return err;
  spi_device_interface_config_t dev = {
      .clock_speed_hz = 10 * 1000 * 1000,
      .mode = 0,
      .spics_io_num = PIN_EPD_CS,
      .queue_size = 1,
  };
  err = spi_bus_add_device(SPI2_HOST, &dev, &s_spi);
  if (err != ESP_OK) return err;
  if (!panel_init()) return ESP_ERR_NOT_FOUND;
  s_fitted = true;
  ESP_LOGI(TAG, "%s ready", EPD_NAME);
  return ESP_OK;
}

/** Landscape framebuffer (1 = black) → panel RAM (portrait, 1 = white), rotated 90°. */
static void convert(const uint8_t *fb) {
  memset(s_ram, 0xFF, sizeof s_ram);
  for (int ny = 0; ny < NATIVE_H; ny++) {
    for (int nx = 0; nx < VIS_W; nx++) {
      int lx = ny, ly = VIS_W - 1 - nx;
      int bit = ly * LAND_W + lx;
      if (fb[bit / 8] & (0x80 >> (bit % 8))) s_ram[ny * ROW_BYTES + nx / 8] &= ~(0x80 >> (nx % 8));
    }
  }
}

static void epd_flush(const uint8_t *fb, bool full) {
  if (!s_fitted) return;
  convert(fb);
  write_ram(0x24);  // the new image
  if (full) {
    write_ram(0x26);  // the "previous" image too
    CMD(0x22, 0xF7);
  } else {
    CMD(0x22, 0xFC);
  }
  int64_t t0 = esp_timer_get_time();
  cmd(0x20, NULL, 0);  // go
  wait_busy(full ? "full refresh" : "partial refresh", 5000);
  int ms = (int)((esp_timer_get_time() - t0) / 1000);
  if (!full) write_ram(0x26);  // base for the next partial refresh
  // A real refresh keeps BUSY high for ~0.3 s (partial) to ~2 s (full); a few ms means the
  // module never ran it: not powered, not connected, or the wrong SPI mode (see `epd`).
  ESP_LOGI(TAG, "%s refresh done in %d ms%s", full ? "full" : "partial", ms,
           ms < 50 ? " (too fast: the module didn't refresh; run `epd`)" : "");
}

/** Bring-up check (console `epd`): reset the module and watch BUSY. A powered SSD1680 holds BUSY
 * high for a moment after a reset and a software reset; no module, no power or the wrong SPI mode
 * leaves it low. Then a full refresh, timed. */
void display_epd_probe(void) {
  if (!s_spi) {
    printf("epd: SPI not set up\n");
    return;
  }
  printf("epd: BUSY idle level %d\n", gpio_get_level(PIN_EPD_BUSY));
  gpio_set_level(PIN_EPD_RST, 0);
  vTaskDelay(pdMS_TO_TICKS(10));
  gpio_set_level(PIN_EPD_RST, 1);
  int64_t t0 = esp_timer_get_time();
  bool seen = false;
  while (esp_timer_get_time() - t0 < 200000) {
    if (gpio_get_level(PIN_EPD_BUSY)) seen = true;
    if (seen && !gpio_get_level(PIN_EPD_BUSY)) break;
  }
  cmd(0x12, NULL, 0);  // software reset
  int64_t t1 = esp_timer_get_time();
  bool seen2 = false;
  int64_t high_us = 0;
  while (esp_timer_get_time() - t1 < 500000) {
    if (gpio_get_level(PIN_EPD_BUSY)) { seen2 = true; high_us = esp_timer_get_time() - t1; }
    else if (seen2) break;
  }
  if (!seen && !seen2) {
    printf("epd: NO ANSWER: BUSY never went high. Check the module's orientation (it lies over the\n"
           "     board toward H5/H6), 3.3 V between its pins 8 (VCC) and 7 (GND), the header and\n"
           "     socket joints, and its SPI jumper on 4-Lines.\n");
    return;
  }
  printf("epd: module answered (BUSY high ~%d ms after the software reset)\n", (int)(high_us / 1000));
  panel_init();
  s_fitted = true;
  memset(s_ram, 0x00, sizeof s_ram);  // all black, then the screen comes back on the next update
  write_ram(0x24);
  write_ram(0x26);
  CMD(0x22, 0xF7);
  int64_t t2 = esp_timer_get_time();
  cmd(0x20, NULL, 0);
  wait_busy("probe refresh", 5000);
  printf("epd: full refresh (all black) took %d ms (expect ~1500-3000)\n",
         (int)((esp_timer_get_time() - t2) / 1000));
}

const display_driver_t display_epd_ssd1680 = {
    .name = EPD_NAME,
    .width = LAND_W,
    .height = LAND_H,
    .init = epd_init,
    .flush = epd_flush,
};
