// Host-test stand-in for ESP-IDF's app descriptor (app.h's FW_VERSION).
#pragma once
typedef struct {
  char version[32];
} esp_app_desc_t;
const esp_app_desc_t *esp_app_get_description(void);
