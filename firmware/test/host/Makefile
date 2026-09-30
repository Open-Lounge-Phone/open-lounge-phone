# Host unit tests for the firmware's pure modules (no ESP-IDF runtime; cJSON comes from IDF_PATH).
#   make -C firmware/test/host        (CI runs it in the firmware job)
IDF_PATH ?= $(HOME)/esp/esp-idf
CJSON := $(IDF_PATH)/components/json/cJSON
MAIN := ../../main
SAN := -fsanitize=address,undefined -fno-omit-frame-pointer
BASE := -std=gnu11 -O1 -g -I$(MAIN) -I$(CJSON) -I. -D_DEFAULT_SOURCE $(SAN)
CFLAGS := $(BASE) -Wall -Wextra -Werror
# test_<module>.c tests main/<module>.c.
TESTS := $(wildcard test_*.c)
MODULES := $(patsubst test_%.c,$(MAIN)/%.c,$(filter-out test_main.c,$(TESTS)))
SRCS := $(TESTS) $(MODULES)

all: run
build/cJSON.o: $(CJSON)/cJSON.c
	@mkdir -p build
	$(CC) $(BASE) -w -c -o $@ $<
build/tests: $(SRCS) build/cJSON.o $(wildcard *.h) $(wildcard $(MAIN)/*.h)
	@mkdir -p build
	$(CC) $(CFLAGS) -o $@ $(SRCS) build/cJSON.o $(SAN) -lm
run: build/tests
	./build/tests
clean:
	rm -rf build
.PHONY: all run clean
