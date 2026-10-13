// labs/main/labs_hid.c: macro pad key combos.
#include "check.h"
#include "labs_hid.h"

TEST(hid_combos) {
  hid_combo_t c;
  CHECK(hid_parse("ctrl+shift+m", &c) && c.modifiers == 0x03 && c.key == 0x10);
  CHECK(hid_parse("cmd+space", &c) && c.modifiers == 0x08 && c.key == 0x2C);
  CHECK(hid_parse("F13", &c) && c.key == 0x68 && !c.modifiers);
  CHECK(hid_parse("f5", &c) && c.key == 0x3E);
  CHECK(hid_parse("alt+1", &c) && c.key == 0x1E);
  CHECK(hid_parse("0", &c) && c.key == 0x27);
  CHECK(hid_parse("mute", &c) && c.media == 0xE2 && !c.key);
  CHECK(!hid_parse("ctrl+mute", &c));
  CHECK(!hid_parse("a+b", &c));
  CHECK(!hid_parse("f99", &c));
  CHECK(!hid_parse("banana", &c));
  CHECK(!hid_parse("", &c));
}
