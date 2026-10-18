#include "build_core.h"

#include <stdio.h>
#include <string.h>

void build_hex(const uint8_t sha[BUILD_SHA_LEN], char out[2 * BUILD_SHA_LEN + 1]) {
  static const char digits[] = "0123456789abcdef";
  for (int i = 0; i < BUILD_SHA_LEN; i++) {
    out[2 * i] = digits[sha[i] >> 4];
    out[2 * i + 1] = digits[sha[i] & 15];
  }
  out[2 * BUILD_SHA_LEN] = '\0';
}

bool build_official(const uint8_t running[BUILD_SHA_LEN], const uint8_t *recorded) {
  if (!recorded) return false;
  static const uint8_t zero[BUILD_SHA_LEN];
  if (!memcmp(running, zero, BUILD_SHA_LEN)) return false;
  return !memcmp(running, recorded, BUILD_SHA_LEN);
}

bool build_slot_key(const char *slot_label, char *out, size_t n) {
  // NVS keys hold at most 15 characters.
  if (!slot_label || !slot_label[0] || n < 16) return false;
  int len = snprintf(out, n, "v_%s", slot_label);
  return len > 0 && len <= 15;
}
