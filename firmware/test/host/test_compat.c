#include "check.h"
#include "compat.h"

static compat_t of(const char *json, int ours) {
  cJSON *m = cJSON_Parse(json);
  compat_t c = compat_from_message(m, ours);
  cJSON_Delete(m);
  return c;
}

TEST(compat_normal_messages_are_fine_whatever_they_carry) {
  CHECK(of("{\"t\":\"config\",\"buttons\":[],\"quiet\":false}", 1) == COMPAT_OK);
  // A newer server's config: extra fields, its range includes ours.
  CHECK(of("{\"t\":\"config\",\"buttons\":[],\"quiet\":false,\"hologram\":{\"on\":true},"
           "\"server\":{\"software\":\"openloungephone/9.0.0\",\"protocol\":{\"min\":1,\"max\":4},"
           "\"features\":[\"video\"]}}",
           1) == COMPAT_OK);
  CHECK(of("{\"t\":\"future.message\",\"x\":1}", 1) == COMPAT_OK);
  CHECK(of("{\"t\":\"error\",\"code\":\"bad_message\",\"message\":\"not supported: x\","
           "\"unsupported\":\"x\"}",
           1) == COMPAT_OK);
  CHECK(of("{\"no_t\":1}", 1) == COMPAT_OK);
}

TEST(compat_too_old_phone_shows_update_needed) {
  CHECK(of("{\"t\":\"config\",\"buttons\":[],\"quiet\":false,"
           "\"update\":{\"minProtocol\":2,\"message\":\"UPDATE NEEDED\"}}",
           1) == COMPAT_UPDATE_NEEDED);
  CHECK(of("{\"t\":\"error\",\"code\":\"unsupported_version\",\"message\":\"Update needed\","
           "\"server\":{\"software\":\"x\",\"protocol\":{\"min\":2,\"max\":3},\"features\":[]}}",
           1) == COMPAT_UPDATE_NEEDED);
  // An older server that doesn't say its range.
  CHECK(of("{\"t\":\"error\",\"code\":\"unsupported_version\",\"message\":\"server speaks protocol 1\"}",
           2) == COMPAT_UPDATE_NEEDED);
}

TEST(compat_newer_phone_says_the_server_is_old) {
  CHECK(of("{\"t\":\"error\",\"code\":\"unsupported_version\",\"message\":\"This server is older\","
           "\"server\":{\"software\":\"x\",\"protocol\":{\"min\":1,\"max\":1},\"features\":[]}}",
           2) == COMPAT_SERVER_TOO_OLD);
  char lines[2][25];
  compat_lines(COMPAT_SERVER_TOO_OLD, lines);
  CHECK_STR(lines[0], "SERVER TOO OLD");
  compat_lines(COMPAT_UPDATE_NEEDED, lines);
  CHECK_STR(lines[0], "UPDATE NEEDED");
  CHECK(strlen(lines[1]) <= 24);
}
