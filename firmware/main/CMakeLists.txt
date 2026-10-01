# Updates (OTA) are off unless the build turns them on (CONFIG_OLP_OTA): then the update key's
# public half is embedded under a fixed name (the embedded symbol comes from the name). Kconfig
# values are empty in the build system's first, requirements-only pass.
set(OLP_EMBED "sim_ca_we1.pem")
if(CONFIG_OLP_OTA)
  get_filename_component(OLP_OTA_PUBKEY_SRC "${CONFIG_OLP_OTA_PUBKEY}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_LIST_DIR}/..")
  if(NOT CONFIG_OLP_OTA_PUBKEY OR NOT EXISTS "${OLP_OTA_PUBKEY_SRC}")
    message(FATAL_ERROR "Updates are on (CONFIG_OLP_OTA) but there is no update key at "
                        "'${CONFIG_OLP_OTA_PUBKEY}'. Make yours with `firmware/tools/release.sh keygen`, "
                        "or turn updates off in menuconfig.")
  endif()
  configure_file("${OLP_OTA_PUBKEY_SRC}" "${CMAKE_CURRENT_BINARY_DIR}/ota_pubkey.pem" COPYONLY)
  list(APPEND OLP_EMBED "${CMAKE_CURRENT_BINARY_DIR}/ota_pubkey.pem")
endif()

idf_component_register(
  SRCS "main.c" "input.c" "signals.c" "display.c" "display_epd.c" "display_ili9341.c" "gfx.c" "net.c" "identity.c"
       "fingerprint_words.c" "phone.c" "strip.c" "menu.c" "proto.c" "console.c" "dsp.c" "ice.c" "audio.c"
       "audio_es8311.c" "audio_test.c" "media.c" "prov.c" "prov_core.c" "ota.c" "ota_core.c" "storage.c" "compat.c"
  INCLUDE_DIRS "."
  EMBED_TXTFILES ${OLP_EMBED}
  PRIV_REQUIRES esp_driver_gpio esp_driver_i2s esp_eth esp_driver_ledc esp_driver_spi esp_driver_i2c esp_timer
                esp_wifi esp_netif esp_event nvs_flash mbedtls json console esp_app_format
                esp-tls app_update esp_http_server esp_http_client efuse
)
