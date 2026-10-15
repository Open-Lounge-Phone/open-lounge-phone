// The display's SPI bus (SPI2: SCLK IO13, MOSI IO14). On hw v0.901 the W5500 shares it (its own
// chip select on IO0, MISO on IO45); ESP-IDF's bus lock gives each device the bus for a whole
// transaction, so the e-paper and the network take turns. Rev A's bus has no MISO.
#pragma once
#include "driver/spi_master.h"
#include "esp_err.h"

#define BOARD_SPI_HOST SPI2_HOST

/** Sets the bus up once (later calls return ESP_OK). */
esp_err_t board_spi_init(void);
