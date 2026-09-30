// ES8311 codec (I2C 0x18). v0 only checks it is there and resets it; the audio path
// (I2S, the earpiece and mic, prompts, WebRTC via esp-webrtc) is TODO.
#include "codec.h"

#include "board.h"
#include "driver/i2c_master.h"
#include "esp_log.h"

static const char *TAG = "codec";

bool codec_init(void) {
  i2c_master_bus_config_t bus_cfg = {
      .i2c_port = I2C_NUM_0,
      .sda_io_num = PIN_I2C_SDA,
      .scl_io_num = PIN_I2C_SCL,
      .clk_source = I2C_CLK_SRC_DEFAULT,
      .glitch_ignore_cnt = 7,
      .flags.enable_internal_pullup = true,  // the board has 4.7k pull-ups too
  };
  i2c_master_bus_handle_t bus;
  if (i2c_new_master_bus(&bus_cfg, &bus) != ESP_OK) return false;
  if (i2c_master_probe(bus, CODEC_I2C_ADDR, 50) != ESP_OK) {
    ESP_LOGW(TAG, "ES8311 not found at 0x%02x (no audio)", CODEC_I2C_ADDR);
    i2c_del_master_bus(bus);
    return false;
  }
  i2c_device_config_t dev_cfg = {
      .dev_addr_length = I2C_ADDR_BIT_LEN_7,
      .device_address = CODEC_I2C_ADDR,
      .scl_speed_hz = 100000,
  };
  i2c_master_dev_handle_t dev;
  if (i2c_master_bus_add_device(bus, &dev_cfg, &dev) != ESP_OK) return false;
  uint8_t reg = 0xFD, id[2] = {0};
  i2c_master_transmit_receive(dev, &reg, 1, id, 2, 50);  // chip id: 0x83 0x11
  const uint8_t reset[] = {0x00, 0x1F}, run[] = {0x00, 0x00};
  i2c_master_transmit(dev, reset, 2, 50);
  i2c_master_transmit(dev, run, 2, 50);
  ESP_LOGI(TAG, "ES8311 found (id %02x%02x), reset; audio path not implemented in v0", id[0], id[1]);
  return true;
}
