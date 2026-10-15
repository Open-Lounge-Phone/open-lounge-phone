#include "board_spi.h"

#include <stdbool.h>

#include "board.h"
#include "sdkconfig.h"

static bool s_ready;

esp_err_t board_spi_init(void) {
  if (s_ready) return ESP_OK;
  spi_bus_config_t bus = {
      .mosi_io_num = PIN_EPD_DIN,
#if BOARD_HAS_ETHERNET && !CONFIG_OLP_QEMU
      .miso_io_num = PIN_ETH_MISO,  // the W5500's; the e-paper only listens
#else
      .miso_io_num = -1,
#endif
      .sclk_io_num = PIN_EPD_CLK,
      .quadwp_io_num = -1,
      .quadhd_io_num = -1,
      .max_transfer_sz = 4096,  // the e-paper's 4000-byte frame chunks; a network frame is < 1.6 KB
  };
  esp_err_t err = spi_bus_initialize(BOARD_SPI_HOST, &bus, SPI_DMA_CH_AUTO);
  if (err == ESP_OK) s_ready = true;
  return err;
}
