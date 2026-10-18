#include "build_core.h"
#include "check.h"

static void fill(uint8_t *sha, uint8_t v) { memset(sha, v, BUILD_SHA_LEN); }

TEST(build_hex_is_lowercase_hex) {
  uint8_t sha[BUILD_SHA_LEN];
  for (int i = 0; i < BUILD_SHA_LEN; i++) sha[i] = (uint8_t)(i * 9 + 0xa0);
  char hex[65];
  build_hex(sha, hex);
  CHECK(strlen(hex) == 64);
  CHECK(!strncmp(hex, "a0a9b2bbc4cdd6dfe8f1fa030c151e27", 32));
}

TEST(build_official_only_for_the_image_the_phone_installed) {
  uint8_t installed[BUILD_SHA_LEN], other[BUILD_SHA_LEN], zero[BUILD_SHA_LEN];
  fill(installed, 0x5a);
  fill(other, 0x5b);
  fill(zero, 0);
  // The update path recorded this image for its slot and it is what runs: official.
  CHECK(build_official(installed, installed));
  // No record for the slot (a build from source, a phone that never updated itself): not.
  CHECK(!build_official(installed, NULL));
  // A USB flash over a slot that once held an update: the record is of another image.
  CHECK(!build_official(other, installed));
  // An image without a hash never counts, even against an all-zero record.
  CHECK(!build_official(zero, zero));
}

TEST(build_records_are_per_slot) {
  char a[16], b[16];
  CHECK(build_slot_key("ota_0", a, sizeof a));
  CHECK(build_slot_key("ota_1", b, sizeof b));
  CHECK_STR(a, "v_ota_0");
  CHECK(strcmp(a, b) != 0);  // a rollback to the other slot keeps that slot's own record
  char small[8];
  CHECK(!build_slot_key("ota_0", small, sizeof small));
  CHECK(!build_slot_key("a-label-far-too-long", a, sizeof a));
  CHECK(!build_slot_key("", a, sizeof a));
}
