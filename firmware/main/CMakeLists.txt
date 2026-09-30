idf_component_register(
  SRCS "main.c" "input.c" "signals.c" "display.c" "display_epd.c" "display_ili9341.c" "gfx.c" "net.c" "identity.c"
       "fingerprint_words.c" "phone.c" "strip.c" "menu.c" "proto.c" "console.c" "dsp.c" "ice.c" "audio.c"
       "audio_es8311.c" "audio_test.c" "media.c" "prov.c" "prov_core.c"
  INCLUDE_DIRS "."
  EMBED_TXTFILES "sim_ca_we1.pem"
  PRIV_REQUIRES esp_driver_gpio esp_driver_i2s esp_eth esp_driver_ledc esp_driver_spi esp_driver_i2c esp_timer
                esp_wifi esp_netif esp_event nvs_flash mbedtls json console esp_app_format
                esp-tls app_update esp_http_server esp_http_client
)
