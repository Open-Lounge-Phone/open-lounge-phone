#include "labs_usb.h"

#include "class/hid/hid_device.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "tinyusb.h"
#include "tinyusb_default_config.h"

static const char *TAG = "labs_usb";

enum { RID_KEYBOARD = 1, RID_MEDIA = 2 };

static const uint8_t REPORT[] = {
    TUD_HID_REPORT_DESC_KEYBOARD(HID_REPORT_ID(RID_KEYBOARD)),
    TUD_HID_REPORT_DESC_CONSUMER(HID_REPORT_ID(RID_MEDIA)),
};

static const char *STRINGS[] = {
    (char[]){0x09, 0x04},
    "Open Lounge Phone",
    "Open Lounge Phone macro pad",
    "0000",
    "Keys",
};

#define CONFIG_LEN (TUD_CONFIG_DESC_LEN + TUD_HID_DESC_LEN)
static const uint8_t CONFIG_DESC[] = {
    TUD_CONFIG_DESCRIPTOR(1, 1, 0, CONFIG_LEN, TUSB_DESC_CONFIG_ATT_REMOTE_WAKEUP, 100),
    TUD_HID_DESCRIPTOR(0, 4, false, sizeof(REPORT), 0x81, 16, 10),
};

uint8_t const *tud_hid_descriptor_report_cb(uint8_t instance) { return REPORT; }
uint16_t tud_hid_get_report_cb(uint8_t instance, uint8_t id, hid_report_type_t type, uint8_t *buf,
                               uint16_t len) {
  return 0;
}
void tud_hid_set_report_cb(uint8_t instance, uint8_t id, hid_report_type_t type, uint8_t const *buf,
                           uint16_t len) {}

static bool s_started;

bool labs_usb_start(void) {
  if (s_started) return true;
  tinyusb_config_t cfg = TINYUSB_DEFAULT_CONFIG();
  cfg.descriptor.device = NULL;
  cfg.descriptor.full_speed_config = CONFIG_DESC;
  cfg.descriptor.string = STRINGS;
  cfg.descriptor.string_count = sizeof STRINGS / sizeof STRINGS[0];
  esp_err_t err = tinyusb_driver_install(&cfg);
  s_started = err == ESP_OK;
  ESP_LOGI(TAG, "USB keyboard %s", s_started ? "on" : esp_err_to_name(err));
  return s_started;
}

bool labs_usb_ready(void) { return s_started && tud_mounted(); }

void labs_usb_send(const hid_combo_t *c) {
  if (!labs_usb_ready()) return;
  if (c->media) {
    uint16_t u = c->media;
    tud_hid_report(RID_MEDIA, &u, sizeof u);
    vTaskDelay(pdMS_TO_TICKS(30));
    u = 0;
    tud_hid_report(RID_MEDIA, &u, sizeof u);
    return;
  }
  uint8_t keys[6] = {c->key};
  tud_hid_keyboard_report(RID_KEYBOARD, c->modifiers, keys);
  vTaskDelay(pdMS_TO_TICKS(30));
  tud_hid_keyboard_report(RID_KEYBOARD, 0, NULL);
}
