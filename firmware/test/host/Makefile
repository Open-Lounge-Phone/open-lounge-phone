# Host unit tests for the firmware's pure modules (no ESP-IDF runtime; cJSON comes from IDF_PATH).
#   make -C firmware/test/host        (CI runs it in the firmware job)
IDF_PATH ?= $(HOME)/esp/esp-idf
CJSON := $(IDF_PATH)/components/json/cJSON
MAIN := ../../main
LABS := ../../labs/main
# The intercom's crypto (lan_crypto.c) uses the same mbedtls sources as the phone, with a config
# that has only what it needs.
MBEDTLS := $(IDF_PATH)/components/mbedtls/mbedtls
MBED_FLAGS := -I$(MBEDTLS)/include -I$(MBEDTLS)/library -DMBEDTLS_CONFIG_FILE='"mbedtls_host_config.h"'
MBED_OBJS := build/mbed_aes.o build/mbed_sha256.o build/mbed_platform_util.o
# libopus for the voice codec's tests (the phone's comes in esp_audio_codec): the system's
# (macOS: brew install opus; Debian/Ubuntu: apt-get install libopus-dev pkg-config).
OPUS_LIBS ?= $(shell pkg-config --libs opus 2>/dev/null || echo -lopus)
# SpeexDSP (components/speexdsp) for the echo canceller's tests, built as the phone builds it.
SPEEX := ../../components/speexdsp
SPEEX_SRCS := mdf preprocess filterbank fftwrap kiss_fft kiss_fftr
SPEEX_OBJS := $(patsubst %,build/speex_%.o,$(SPEEX_SRCS))
SAN := -fsanitize=address,undefined -fno-omit-frame-pointer
BASE := -std=gnu11 -O1 -g -I$(MAIN) -I$(LABS) -I$(CJSON) -I. -I$(SPEEX)/include -D_DEFAULT_SOURCE $(MBED_FLAGS) $(SAN)
CFLAGS := $(BASE) -Wall -Wextra -Werror
# test_<module>.c tests main/<module>.c (or labs/main/<module>.c, the labs firmware's).
TESTS := $(wildcard test_*.c)
MODULES := $(foreach t,$(patsubst test_%.c,%,$(filter-out test_main.c,$(TESTS))),\
             $(firstword $(wildcard $(MAIN)/$(t).c $(LABS)/$(t).c)))
SRCS := $(TESTS) $(MODULES)

all: run
build/cJSON.o: $(CJSON)/cJSON.c
	@mkdir -p build
	$(CC) $(BASE) -w -c -o $@ $<
build/mbed_%.o: $(MBEDTLS)/library/%.c mbedtls_host_config.h
	@mkdir -p build
	$(CC) $(BASE) -w -c -o $@ $<
build/speex_%.o: $(SPEEX)/src/%.c $(SPEEX)/src/config.h
	@mkdir -p build
	$(CC) $(BASE) -I$(SPEEX)/src -DHAVE_CONFIG_H -w -c -o $@ $<
build/tests: $(SRCS) build/cJSON.o $(MBED_OBJS) $(SPEEX_OBJS) $(wildcard *.h) $(wildcard $(MAIN)/*.h)
	@mkdir -p build
	$(CC) $(CFLAGS) -o $@ $(SRCS) build/cJSON.o $(MBED_OBJS) $(SPEEX_OBJS) $(SAN) $(OPUS_LIBS) -lm
run: build/tests
	./build/tests
clean:
	rm -rf build
.PHONY: all run clean
