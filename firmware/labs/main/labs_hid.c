#include "labs_hid.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const struct { const char *name; uint8_t key; } NAMED[] = {
    {"enter", 0x28}, {"return", 0x28}, {"esc", 0x29}, {"escape", 0x29}, {"backspace", 0x2A},
    {"tab", 0x2B}, {"space", 0x2C}, {"minus", 0x2D}, {"equal", 0x2E}, {"comma", 0x36},
    {"period", 0x37}, {"slash", 0x38}, {"right", 0x4F}, {"left", 0x50}, {"down", 0x51},
    {"up", 0x52}, {"home", 0x4A}, {"end", 0x4D}, {"pageup", 0x4B}, {"pagedown", 0x4E},
    {"delete", 0x4C}, {"insert", 0x49}, {"printscreen", 0x46},
};
static const struct { const char *name; uint16_t usage; } MEDIA[] = {
    {"mute", 0xE2}, {"volup", 0xE9}, {"voldown", 0xEA}, {"play", 0xCD}, {"next", 0xB5},
    {"prev", 0xB6}, {"stop", 0xB7},
};

bool hid_parse(const char *combo, hid_combo_t *out) {
  hid_combo_t c = {0};
  if (!combo || !*combo) return false;
  char buf[64];
  snprintf(buf, sizeof buf, "%s", combo);
  for (char *p = buf; *p; p++) *p = (char)tolower((unsigned char)*p);
  bool any = false;
  for (char *tok = strtok(buf, "+ "); tok; tok = strtok(NULL, "+ ")) {
    if (!strcmp(tok, "ctrl") || !strcmp(tok, "control")) { c.modifiers |= 0x01; continue; }
    if (!strcmp(tok, "shift")) { c.modifiers |= 0x02; continue; }
    if (!strcmp(tok, "alt") || !strcmp(tok, "option")) { c.modifiers |= 0x04; continue; }
    if (!strcmp(tok, "gui") || !strcmp(tok, "cmd") || !strcmp(tok, "win") || !strcmp(tok, "super")) {
      c.modifiers |= 0x08;
      continue;
    }
    if (c.key || c.media) return false;           // one key per combo
    any = true;
    if (strlen(tok) == 1 && tok[0] >= 'a' && tok[0] <= 'z') { c.key = (uint8_t)(0x04 + tok[0] - 'a'); continue; }
    if (strlen(tok) == 1 && tok[0] >= '1' && tok[0] <= '9') { c.key = (uint8_t)(0x1E + tok[0] - '1'); continue; }
    if (!strcmp(tok, "0")) { c.key = 0x27; continue; }
    if (tok[0] == 'f' && isdigit((unsigned char)tok[1])) {
      int f = atoi(tok + 1);
      if (f >= 1 && f <= 12) { c.key = (uint8_t)(0x3A + f - 1); continue; }
      if (f >= 13 && f <= 24) { c.key = (uint8_t)(0x68 + f - 13); continue; }
      return false;
    }
    bool found = false;
    for (size_t i = 0; i < sizeof NAMED / sizeof NAMED[0] && !found; i++)
      if (!strcmp(tok, NAMED[i].name)) { c.key = NAMED[i].key; found = true; }
    for (size_t i = 0; i < sizeof MEDIA / sizeof MEDIA[0] && !found; i++)
      if (!strcmp(tok, MEDIA[i].name)) { c.media = MEDIA[i].usage; found = true; }
    if (!found) return false;
  }
  if (!any && !c.modifiers) return false;
  if (c.media && c.modifiers) return false;       // media keys go alone
  *out = c;
  return true;
}
