// Stand-in display for the Wokwi simulator: an ILI9341 SPI TFT (320 x 240), on the e-paper's
// pins (CLK, DIN, CS, DC, RST; no BUSY). It draws the same 296 x 128 strip image, black on an
// e-paper grey, centred. Wokwi has no supported 2.9" e-paper part (see ../README.md).
#include <string.h>

#include "board.h"
#include "display.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "ili9341";
#define W 320
#define H 240
#define IMG_W 296
#define IMG_H 128
#define FG 0x10A2  // near black (RGB565)
#define BG 0xDEDA  // e-paper grey

static spi_device_handle_t s_spi;
static uint16_t s_line[W];

static void send(bool data, const void *buf, size_t len) {
  gpio_set_level(PIN_EPD_DC, data);
  spi_transaction_t tx = {.length = len * 8, .tx_buffer = buf};
  spi_device_polling_transmit(s_spi, &tx);
}

static void cmd(uint8_t c, const uint8_t *d, size_t n) {
  send(false, &c, 1);
  if (n) send(true, d, n);
}
#define CMD(c, ...)                     \
  do {                                  \
    const uint8_t d_[] = {__VA_ARGS__}; \
    cmd((c), d_, sizeof d_);            \
  } while (0)

static void window(int x0, int y0, int x1, int y1) {
  CMD(0x2A, x0 >> 8, x0 & 0xFF, x1 >> 8, x1 & 0xFF);
  CMD(0x2B, y0 >> 8, y0 & 0xFF, y1 >> 8, y1 & 0xFF);
  cmd(0x2C, NULL, 0);
}

static esp_err_t init(void) {
  gpio_config_t out = {.pin_bit_mask = (1ULL << PIN_EPD_DC) | (1ULL << PIN_EPD_RST),
                       .mode = GPIO_MODE_OUTPUT};
  gpio_config(&out);
  spi_bus_config_t bus = {.mosi_io_num = PIN_EPD_DIN,
                          .miso_io_num = -1,
                          .sclk_io_num = PIN_EPD_CLK,
                          .quadwp_io_num = -1,
                          .quadhd_io_num = -1,
                          .max_transfer_sz = W * 2};
  esp_err_t err = spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO);
  if (err != ESP_OK) return err;
  spi_device_interface_config_t dev = {.clock_speed_hz = 40 * 1000 * 1000,
                                       .mode = 0,
                                       .spics_io_num = PIN_EPD_CS,
                                       .queue_size = 1};
  if ((err = spi_bus_add_device(SPI2_HOST, &dev, &s_spi)) != ESP_OK) return err;
  gpio_set_level(PIN_EPD_RST, 0);
  vTaskDelay(pdMS_TO_TICKS(10));
  gpio_set_level(PIN_EPD_RST, 1);
  vTaskDelay(pdMS_TO_TICKS(120));
  cmd(0x01, NULL, 0);  // software reset
  vTaskDelay(pdMS_TO_TICKS(120));
  cmd(0x11, NULL, 0);  // sleep out
  vTaskDelay(pdMS_TO_TICKS(120));
  CMD(0x3A, 0x55);     // 16-bit colour
  CMD(0x36, 0x28);     // landscape (MV), BGR
  cmd(0x29, NULL, 0);  // display on
  for (int x = 0; x < W; x++) s_line[x] = __builtin_bswap16(BG);
  window(0, 0, W - 1, H - 1);
  for (int y = 0; y < H; y++) send(true, s_line, sizeof s_line);
  ESP_LOGI(TAG, "ILI9341 stand-in for the e-paper strip (simulator)");
  return ESP_OK;
}

static void flush(const uint8_t *fb, bool full) {
  int x0 = (W - IMG_W) / 2, y0 = (H - IMG_H) / 2;
  window(x0, y0, x0 + IMG_W - 1, y0 + IMG_H - 1);
  for (int y = 0; y < IMG_H; y++) {
    for (int x = 0; x < IMG_W; x++) {
      int bit = y * IMG_W + x;
      bool on = fb[bit / 8] & (0x80 >> (bit % 8));
      s_line[x] = __builtin_bswap16(on ? FG : BG);
    }
    send(true, s_line, IMG_W * 2);
  }
  ESP_LOGI(TAG, "refresh done");
}

const display_driver_t display_ili9341_sim = {
    .name = "ILI9341 (simulator stand-in)",
    .width = IMG_W,
    .height = IMG_H,
    .init = init,
    .flush = flush,
};
