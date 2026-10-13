// labs/main/labs_cfg.c: the labs settings JSON.
#include <stdlib.h>

#include "check.h"
#include "labs_cfg.h"

TEST(labs_cfg_parses_keys_and_features) {
  labs_cfg_t c;
  char err[96] = "";
  const char *j = "{\"name\":\"Kitchen\",\"mode\":\"intercom\",\"keys\":["
                  "{\"key\":\"1\",\"action\":\"intercom\",\"target\":\"Kid's room\"},"
                  "{\"key\":2,\"action\":\"ha\",\"service\":\"scene.turn_on\",\"target\":\"scene.night\",\"label\":\"Lights off\"},"
                  "{\"key\":\"0\",\"action\":\"story\",\"url\":\"http://nas/s.wav\"}],"
                  "\"ha\":{\"url\":\"http://ha:8123/\",\"token\":\"T0K\",\"status\":\"cover.garage\",\"status_label\":\"garage\"},"
                  "\"checkin\":{\"by\":\"10:00\",\"reminders\":[{\"at\":\"08:30\",\"text\":\"Pills\"}]}}";
  CHECK(labs_cfg_parse(j, NULL, &c, err, sizeof err));
  CHECK_STR(c.name, "KITCHEN");
  CHECK(c.mode == LM_INTERCOM);
  CHECK(c.keys[0].action == LA_INTERCOM);
  CHECK_STR(c.keys[0].target, "KID'S ROOM");
  CHECK(c.keys[1].action == LA_HA);
  CHECK_STR(c.keys[1].label, "LIGHTS OFF");
  CHECK(c.keys[9].action == LA_STORY);       // "0" is the tenth key
  CHECK(c.keys[2].action == LA_PHONE);       // unset keys stay speed dial
  CHECK_STR(c.ha_url, "http://ha:8123");     // no trailing slash
  CHECK(c.checkin_by == 600 && c.n_reminders == 1 && c.reminders[0].at == 510);
  CHECK_STR(c.reminders[0].text, "PILLS");
  // The token never goes back to the page, and a blank one keeps the old one.
  char *pub = labs_cfg_json(&c, false);
  CHECK(strstr(pub, "T0K") == NULL && strstr(pub, "\"token_set\":true"));
  labs_cfg_t again;
  CHECK(labs_cfg_parse(pub, &c, &again, err, sizeof err));
  CHECK_STR(again.ha_token, "T0K");
  CHECK(again.keys[1].action == LA_HA && again.checkin_by == 600);
  free(pub);
}

TEST(labs_cfg_refuses_bad_input) {
  labs_cfg_t c;
  char err[96];
  CHECK(!labs_cfg_parse("nope", NULL, &c, err, sizeof err));
  CHECK(!labs_cfg_parse("{\"mode\":\"fax\"}", NULL, &c, err, sizeof err));
  CHECK(!labs_cfg_parse("{\"keys\":[{\"key\":\"x\",\"action\":\"intercom\",\"target\":\"A\"}]}", NULL, &c, err, sizeof err));
  CHECK(!labs_cfg_parse("{\"keys\":[{\"key\":\"1\",\"action\":\"intercom\"}]}", NULL, &c, err, sizeof err));
  CHECK(strstr(err, "needs a target") != NULL);
  CHECK(!labs_cfg_parse("{\"keys\":[{\"key\":\"1\",\"action\":\"story\",\"url\":\"ftp://x\"}]}", NULL, &c, err, sizeof err));
  CHECK(!labs_cfg_parse("{\"checkin\":{\"by\":\"25:00\"}}", NULL, &c, err, sizeof err));
  CHECK(labs_parse_hhmm("07:05") == 425 && labs_parse_hhmm("7") == -1);
  char lab[25];
  labs_key_t k = {.action = LA_CHECKIN};
  labs_key_label(&k, 0, lab, sizeof lab);
  CHECK_STR(lab, "I'M OK");
}
