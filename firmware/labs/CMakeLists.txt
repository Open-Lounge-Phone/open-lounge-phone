# Open Lounge Phone LABS firmware (0.0.0): the phone plus house intercom, daily check-in, USB macro
# pad, Home Assistant panel, dial-a-story and doorbell. Its own project, so the phone firmware in
# firmware/ stays as it is: it compiles the same sources (../main) plus labs modules (main/).
#   firmware/labs/labs.sh build | flash | monitor
cmake_minimum_required(VERSION 3.16)
set(PROJECT_VER "0.0.0")
# The phone's defaults, then the labs ones.
set(SDKCONFIG_DEFAULTS "${CMAKE_CURRENT_LIST_DIR}/../sdkconfig.defaults;${CMAKE_CURRENT_LIST_DIR}/sdkconfig.labs")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(openloungephone-labs)
