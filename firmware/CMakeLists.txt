# Open Lounge Phone firmware (ESP-IDF v5.5, ESP32-S3). See README.md.
cmake_minimum_required(VERSION 3.16)
# esp_peer (call audio) ships prebuilt libraries built against ESP-IDF 5.5 (they call esp_log()).
if(DEFINED ENV{IDF_PATH} AND EXISTS "$ENV{IDF_PATH}/tools/cmake/version.cmake")
  include("$ENV{IDF_PATH}/tools/cmake/version.cmake")
  if("${IDF_VERSION_MAJOR}.${IDF_VERSION_MINOR}" VERSION_LESS "5.5")
    message(FATAL_ERROR "ESP-IDF ${IDF_VERSION_MAJOR}.${IDF_VERSION_MINOR} found; this firmware needs v5.5 "
                        "(see firmware/README.md: v5.5.5)")
  endif()
endif()
set(PROJECT_VER "0.4.0")
# Test builds (the OTA test) set their own version; releases use the line above.
if(DEFINED ENV{OLP_FW_VERSION})
  set(PROJECT_VER "$ENV{OLP_FW_VERSION}")
endif()
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(openloungephone)
