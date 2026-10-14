// main/notice.c: a notice from the space on the ready screen.
#include <string.h>

#include "check.h"
#include "notice.h"

static bool set(notice_t *n, const char *json) {
  cJSON *m = cJSON_Parse(json);
  bool fresh = notice_set(n, m);
  cJSON_Delete(m);
  return fresh;
}

TEST(notice_shows_chimes_once_and_clears) {
  notice_t n;
  notice_init(&n);
  char out[2][41];
  CHECK(notice_lines(&n, out) == 0);
  CHECK(set(&n, "{\"t\":\"notice\",\"id\":\"n1\",\"lines\":[\"Bus is here\"],\"from\":\"Mom\"}"));
  CHECK(notice_lines(&n, out) == 1);
  CHECK_STR(out[0], "BUS IS HERE");
  char path[200];
  CHECK(!notice_audio_path(&n, path, sizeof path));
  // Its recording arrives: no second chime, and the phone can play it.
  CHECK(!set(&n,
             "{\"t\":\"notice\",\"id\":\"n1\",\"lines\":[\"BUS IS HERE\"],"
             "\"audio\":{\"token\":\"tok123\",\"durationMs\":2000}}"));
  CHECK(notice_audio_path(&n, path, sizeof path));
  CHECK_STR(path, "/api/notices/n1/audio?token=tok123");
  CHECK(n.duration_ms == 2000);
  // Another notice replaces it (a chime again); clearing the old one changes nothing.
  CHECK(set(&n,
            "{\"t\":\"notice\",\"id\":\"n2\",\"lines\":[\"KITCHEN CLOSES\",\"AT 10 \xC3\xA9tc and more\"]}"));
  CHECK(notice_lines(&n, out) == 2);
  CHECK_STR(out[1], "AT 10 ??TC AND M");
  notice_clear(&n, "n1");
  CHECK(n.active);
  notice_clear(&n, "n2");
  CHECK(!n.active && notice_lines(&n, out) == 0);
  // Junk is ignored.
  CHECK(!set(&n, "{\"t\":\"notice\",\"lines\":[]}"));
  CHECK(!n.active);
}
