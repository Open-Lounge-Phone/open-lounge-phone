#include "check.h"
#include "ota_core.h"

static const char *GOOD =
    "{\"board\":\"minimal-revA\",\"version\":\"0.2.0\",\"url\":\"https://github.com/o/r/releases/download/fw-0.2.0/olp.bin\","
    "\"size\":1234567,\"sha256\":\"ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789\","
    "\"signature\":\"c2lnbmF0dXJl\"}";

TEST(ota_manifest_parses) {
  ota_manifest_t m;
  CHECK(ota_manifest_parse(GOOD, &m) == NULL);
  CHECK_STR(m.version, "0.2.0");
  CHECK(m.size == 1234567);
  CHECK_STR(m.sha256, "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");  // lowercased
  char text[512];
  int n = ota_manifest_signed_text(&m, text, sizeof text);
  CHECK(n > 0);
  CHECK_STR(m.board, "minimal-revA");
  CHECK_STR(text,
            "olp-ota-v1\nminimal-revA\n0.2.0\nhttps://github.com/o/r/releases/download/fw-0.2.0/olp.bin\n"
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\n1234567\n");
  CHECK(ota_manifest_signed_text(&m, text, 20) == -1);
}

static const char *with(const char *field, const char *value) {
  static char buf[1024];
  // Replace one field of GOOD by `"field":value`.
  char key[40];
  snprintf(key, sizeof key, "\"%s\":", field);
  const char *at = strstr(GOOD, key);
  const char *end = at + strlen(key);
  if (*end == '"') end = strchr(end + 1, '"') + 1;
  else while (*end != ',' && *end != '}') end++;
  snprintf(buf, sizeof buf, "%.*s%s%s%s", (int)(at - GOOD), GOOD, key, value, end);
  return buf;
}

TEST(ota_manifest_rejects_bad_fields) {
  ota_manifest_t m;
  CHECK(ota_manifest_parse("nope", &m) != NULL);
  CHECK(ota_manifest_parse("[]", &m) != NULL);
  CHECK(ota_manifest_parse(with("version", "\"1.2\""), &m) != NULL);
  CHECK(ota_manifest_parse(with("version", "\"1.2.3.4\""), &m) != NULL);
  CHECK(ota_manifest_parse(with("version", "\"1.2.x\""), &m) != NULL);
  CHECK(ota_manifest_parse(with("version", "\"1.2.3-rc.1\""), &m) == NULL);
  CHECK(ota_manifest_parse(with("version", "\"1.2.3\\n0.0.1\""), &m) != NULL);  // no newlines
  CHECK(ota_manifest_parse(with("url", "\"http://insecure/x.bin\""), &m) != NULL);
  CHECK(ota_manifest_parse(with("sha256", "\"abc\""), &m) != NULL);
  CHECK(ota_manifest_parse(with("sha256", "\"zz" "cdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\""), &m) != NULL);
  CHECK(ota_manifest_parse(with("size", "0"), &m) != NULL);
  CHECK(ota_manifest_parse(with("size", "1.5e3"), &m) == NULL);  // 1500
  CHECK(ota_manifest_parse(with("size", "1500.5"), &m) != NULL);
  CHECK(ota_manifest_parse(with("size", "99999999"), &m) != NULL);
  CHECK(ota_manifest_parse(with("signature", "\"\""), &m) != NULL);
  CHECK(ota_manifest_parse(with("board", "\"\""), &m) != NULL);
  CHECK(ota_manifest_parse(with("board", "\"minimal-revA\\nx\""), &m) != NULL);
  CHECK(ota_manifest_parse(with("size", "\"12345\""), &m) != NULL);
}

TEST(ota_versions_order) {
  CHECK(ota_version_cmp("0.1.0", "0.2.0") < 0);
  CHECK(ota_version_cmp("0.10.0", "0.9.9") > 0);
  CHECK(ota_version_cmp("1.0.0", "1.0.0") == 0);
  CHECK(ota_version_cmp("1.0.0-rc1", "1.0.0") < 0);
  CHECK(ota_version_cmp("1.0.0", "1.0.0-rc1") > 0);
  CHECK(ota_version_cmp("1.0.0-rc1", "1.0.0-rc2") < 0);
  CHECK(ota_version_cmp("2.0.0", "10.0.0") < 0);
}

TEST(ota_installs_only_idle_on_hook_at_night) {
  ota_ctx_t c = {.on_hook = true, .idle = true, .idle_ms = OTA_IDLE_MS, .local_minute = 150,
                 .night_only = true};
  CHECK(ota_may_install(&c));
  c.local_minute = OTA_NIGHT_END;  // 05:00: too late
  CHECK(!ota_may_install(&c));
  c.local_minute = OTA_NIGHT_START - 1;  // 01:59: too early
  CHECK(!ota_may_install(&c));
  c.local_minute = -1;  // no clock
  CHECK(!ota_may_install(&c));
  c.night_only = false;  // any time (Kconfig)
  CHECK(ota_may_install(&c));
  c.on_hook = false;
  CHECK(!ota_may_install(&c));
  c.on_hook = true;
  c.idle = false;
  CHECK(!ota_may_install(&c));
  c.idle = true;
  c.idle_ms = OTA_IDLE_MS - 1;
  CHECK(!ota_may_install(&c));
}

TEST(ota_manifest_must_be_for_this_board_and_newer) {
  ota_manifest_t m;
  CHECK(ota_manifest_parse(GOOD, &m) == NULL);
  CHECK(ota_manifest_applies(&m, "minimal-revA", "0.1.0") == NULL);
  CHECK_STR(ota_manifest_applies(&m, "minimal-revB", "0.1.0"), "for another board");
  CHECK_STR(ota_manifest_applies(&m, "hw-v0.1", "0.1.0"), "for another board");
  CHECK_STR(ota_manifest_applies(&m, "minimal-revA", "0.2.0"), "up to date");
  CHECK_STR(ota_manifest_applies(&m, "minimal-revA", "0.3.0"), "up to date");
  // A manifest without a board is refused outright.
  CHECK(ota_manifest_parse(
            "{\"version\":\"0.2.0\",\"url\":\"https://x/y.bin\",\"size\":2048,"
            "\"sha256\":\"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\","
            "\"signature\":\"c2ln\"}",
            &m) != NULL);
}
