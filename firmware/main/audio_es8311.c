// The ES8311 codec (I2C 0x18) on I2S0: the handset's earpiece (OUTP) and electret mic (MIC1).
// 8 kHz, 16-bit, mono, MCLK = 256 x fs = 2.048 MHz from the S3 (the codec is the I2S slave).
// Register values follow the ES8311 user guide and Espressif's es8311 driver (esp-bsp, Apache-2.0),
// rewritten on the new i2c_master API (the legacy I2C driver can't share the bus with it).
#include <string.h>

#include "audio_dev.h"
#include "board.h"
#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "dsp.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

static const char *TAG = "es8311";

static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_dev;
static i2s_chan_handle_t s_tx, s_rx;
static bool s_mic_on, s_rx_enabled;

static esp_err_t wr(uint8_t reg, uint8_t val) {
  uint8_t b[2] = {reg, val};
  return i2c_master_transmit(s_dev, b, 2, 50);
}

static uint8_t rd(uint8_t reg) {
  uint8_t v = 0;
  i2c_master_transmit_receive(s_dev, &reg, 1, &v, 1, 50);
  return v;
}

static bool bus_up(void) {
  if (s_bus) return true;
  i2c_master_bus_config_t cfg = {
      .i2c_port = I2C_NUM_0,
      .sda_io_num = PIN_I2C_SDA,
      .scl_io_num = PIN_I2C_SCL,
      .clk_source = I2C_CLK_SRC_DEFAULT,
      .glitch_ignore_cnt = 7,
      .flags.enable_internal_pullup = true,  // the board has 4.7k pull-ups too
  };
  return i2c_new_master_bus(&cfg, &s_bus) == ESP_OK;
}

bool audio_es8311_present(void) {
  return bus_up() && i2c_master_probe(s_bus, CODEC_I2C_ADDR, 50) == ESP_OK;
}

/** DAC volume register 0x32: 0xBF = 0 dB, 0.5 dB per step, 0 = -95.5 dB. */
static void set_volume_db(float db) {
  if (!s_dev) return;
  if (db > 0) db = 0;
  int reg = 0xBF + (int)(db * 2);
  if (reg < 0) reg = 0;
  wr(0x32, (uint8_t)reg);
}

static void speaker(bool on) {
  if (!s_dev) return;
  uint8_t r31 = rd(0x31);
  // DAC soft mute (bits 6:5) when the earpiece should be silent (on the hook).
  wr(0x31, on ? (r31 & ~0x60) : (r31 | 0x60));
}

static void mic(bool on) {
  if (!s_dev || on == s_mic_on) return;
  s_mic_on = on;
  if (on) {
    // PGA gain in 3 dB steps (0-10); MIC1P/MIC1N differential input; ADC volume 0 dB.
    wr(0x14, 0x10 | (CONFIG_OLP_MIC_PGA_DB / 3));
    wr(0x17, 0xBF);
    if (!s_rx_enabled && i2s_channel_enable(s_rx) == ESP_OK) s_rx_enabled = true;
  } else {
    wr(0x17, 0x00);  // ADC volume to mute
    wr(0x14, 0x00);  // PGA off
    if (s_rx_enabled && i2s_channel_disable(s_rx) == ESP_OK) s_rx_enabled = false;
  }
  ESP_LOGI(TAG, "mic %s", on ? "on" : "off");
}

static esp_err_t init(void) {
  if (!audio_es8311_present()) {
    ESP_LOGW(TAG, "ES8311 not found at 0x%02x", CODEC_I2C_ADDR);
    return ESP_ERR_NOT_FOUND;
  }
  i2c_device_config_t dev_cfg = {
      .dev_addr_length = I2C_ADDR_BIT_LEN_7,
      .device_address = CODEC_I2C_ADDR,
      .scl_speed_hz = 100000,
  };
  esp_err_t err = i2c_master_bus_add_device(s_bus, &dev_cfg, &s_dev);
  if (err != ESP_OK) return err;

  // I2S first: the codec runs from our MCLK.
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  chan.dma_desc_num = 4;
  chan.dma_frame_num = DSP_FRAME;
  chan.auto_clear = true;  // underflow plays silence, not the last buffer again
  err = i2s_new_channel(&chan, &s_tx, &s_rx);
  if (err != ESP_OK) return err;
  i2s_std_config_t std = {
      .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(DSP_RATE),  // MCLK = 256 x fs
      .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
      .gpio_cfg =
          {
              .mclk = PIN_I2S_MCLK,
              .bclk = PIN_I2S_BCLK,
              .ws = PIN_I2S_WS,
              .dout = PIN_I2S_DOUT,
              .din = PIN_I2S_DIN,
          },
  };
  if ((err = i2s_channel_init_std_mode(s_tx, &std)) != ESP_OK) return err;
  if ((err = i2s_channel_init_std_mode(s_rx, &std)) != ESP_OK) return err;
  i2s_channel_enable(s_tx);

  uint8_t id_reg = 0xFD, id[2] = {0};
  i2c_master_transmit_receive(s_dev, &id_reg, 1, id, 2, 50);  // chip id: 0x83 0x11
  // Reset, then power on as an I2S slave.
  wr(0x00, 0x1F);
  vTaskDelay(pdMS_TO_TICKS(20));
  wr(0x00, 0x00);
  wr(0x00, 0x80);
  // Clocks: all on, MCLK from the MCLK pin; dividers for 2.048 MHz / 8 kHz
  // (coefficient row {2048000, 8000, pre_div 1, mult 0, adc_div 1, dac_div 1, fs 0,
  // lrck 0x00ff, bclk_div 4, adc_osr 0x10, dac_osr 0x10}).
  wr(0x01, 0x3F);
  wr(0x02, 0x00);
  wr(0x03, 0x10);
  wr(0x04, 0x10);
  wr(0x05, 0x00);
  wr(0x06, 0x03);
  wr(0x07, 0x00);
  wr(0x08, 0xFF);
  // Serial port: I2S, 16-bit, in and out.
  wr(0x09, 0x0C);
  wr(0x0A, 0x0C);
  // Analog power, ADC modulator + PGA, DAC on, earpiece (HP) driver on.
  wr(0x0D, 0x01);
  wr(0x0E, 0x02);
  wr(0x12, 0x00);
  wr(0x13, 0x10);
  wr(0x1C, 0x6A);  // ADC: equalizer bypass, digital DC offset cancel
  wr(0x37, 0x08);  // DAC: equalizer bypass
  wr(0x16, 0x00);  // ADC gain scale-up 0 dB (the PGA does the gain)
  s_mic_on = true;
  mic(false);
  speaker(false);
  ESP_LOGI(TAG, "ES8311 (id %02x%02x) ready: 8 kHz, mic PGA %d dB", id[0], id[1],
           CONFIG_OLP_MIC_PGA_DB);
  return ESP_OK;
}

static int read_pcm(int16_t *pcm, size_t n) {
  size_t got = 0;
  if (!s_mic_on || i2s_channel_read(s_rx, pcm, n * 2, &got, pdMS_TO_TICKS(100)) != ESP_OK) {
    memset(pcm, 0, n * 2);
    return 0;
  }
  return (int)(got / 2);
}

static void write_pcm(const int16_t *pcm, size_t n) {
  size_t done = 0;
  i2s_channel_write(s_tx, pcm, n * 2, &done, pdMS_TO_TICKS(100));  // blocks: paces the task
}

const audio_dev_t audio_dev_es8311 = {
    .name = "es8311",
    .init = init,
    .speaker = speaker,
    .mic = mic,
    .volume_db = set_volume_db,
    .read = read_pcm,
    .write = write_pcm,
};
