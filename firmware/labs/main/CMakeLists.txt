# The phone's sources (../../main) plus the labs modules here.
set(PHONE "${CMAKE_CURRENT_LIST_DIR}/../../main")
set(PHONE_SRCS main.c input.c signals.c display.c display_epd.c display_ili9341.c gfx.c net.c identity.c
    fingerprint_words.c phone.c screens.c snake.c selftest.c strip.c vmleave.c vmplay.c wav.c marquee.c
    lounge.c notice.c menu.c proto.c console.c dsp.c agc.c jbuf.c plc.c resample.c voice.c sdp.c fifo.c ice.c audio.c audio_es8311.c audio_test.c media.c prov.c
    prov_core.c ota.c ota_core.c storage.c compat.c calls.c
    intercom.c lan_crypto.c lan.c board_spi.c eth.c netsel.c)
list(TRANSFORM PHONE_SRCS PREPEND "${PHONE}/")
idf_component_register(
  SRCS ${PHONE_SRCS} "labs.c" "labs_cfg.c" "labs_checkin.c" "labs_hid.c" "labs_web.c"
       "labs_usb.c"
  INCLUDE_DIRS "." "${PHONE}"
  EMBED_TXTFILES "${PHONE}/sim_ca_we1.pem"
  PRIV_REQUIRES esp_driver_gpio esp_driver_i2s esp_eth esp_driver_ledc esp_driver_spi esp_driver_i2c esp_timer
                esp_wifi esp_netif esp_event nvs_flash mbedtls json console esp_app_format
                esp-tls app_update esp_http_server esp_http_client efuse lwip bootloader_support
                espressif__esp_audio_codec
)
