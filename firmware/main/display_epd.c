// WeAct Studio 2.9" e-paper module (296 x 128, SSD1680) on SPI + DC/RST/BUSY. Command
// sequence as in GxEPD2_290_T94 / the Waveshare 2.9" V2 driver (the same controller).
// Full refresh (0x22 0xF7) every FULL_EVERY updates, fast partial refresh (0x22 0xFC, the
// controller's built-in waveform) in between. TODO: confirm the partial mode on a real panel.
#include <string.h>

#include "board.h"
#include "display.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "epd";
#define NATIVE_W 128  // source lines (x)
#define NATIVE_H 296  // gate lines (y)
#define ROW_BYTES (NATIVE_W / 8)
#define LAND_W 296
#define LAND_H 128

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
  CMD(0x01, (NATIVE_H - 1) & 0xFF, (NATIVE_H - 1) >> 8, 0x00);  // driver output: 296 gates
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
  ESP_LOGI(TAG, "SSD1680 2.9\" e-paper ready");
  return ESP_OK;
}

/** Landscape framebuffer (1 = black) → panel RAM (portrait, 1 = white), rotated 90°. */
static void convert(const uint8_t *fb) {
  memset(s_ram, 0xFF, sizeof s_ram);
  for (int ny = 0; ny < NATIVE_H; ny++) {
    for (int nx = 0; nx < NATIVE_W; nx++) {
      int lx = ny, ly = NATIVE_W - 1 - nx;
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
  cmd(0x20, NULL, 0);  // go
  wait_busy(full ? "full refresh" : "partial refresh", 5000);
  if (!full) write_ram(0x26);  // base for the next partial refresh
  ESP_LOGI(TAG, "%s refresh done", full ? "full" : "partial");
}

const display_driver_t display_epd_ssd1680 = {
    .name = "WeAct 2.9\" e-paper (SSD1680)",
    .width = LAND_W,
    .height = LAND_H,
    .init = epd_init,
    .flush = epd_flush,
};
