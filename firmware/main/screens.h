// Pixel screens beyond text: the boot logo, the setup QR code, About and the diagnostics page (docs/phone-ux.md).
#pragma once
#include <stdbool.h>
#include <stdint.h>

/** The boot screen: the mark and "OPEN LOUNGE PHONE", the firmware version small. */
void screen_boot(uint8_t *fb, int w, int h, const char *version);
/** MENU → 0: firmware, board, server and the public key part (the four fingerprint words). */
void screen_about(uint8_t *fb, int w, int h, const char *fw, const char *board, const char *server,
                  const char *const *words);
/** A page of label / value rows under a title bar (MENU → 7 diagnostics), an optional footer. */
void screen_page(uint8_t *fb, int w, int h, const char *title, const char *const rows[][2], int n,
                 const char *footer);
/**
 * Handset up, nothing dialled: whose phone it is in the title bar, then who is on each digit key
 * (labels in protocol order: 1-9 → 0-8, 0 → 9; "" = nobody) as 1-5 and 6-0 columns, and the
 * status at the bottom ("PRESS A KEY TO CALL", "BUSY - PRESS A KEY").
 */
void screen_keys(uint8_t *fb, int w, int h, const char *title, const char *const labels[10],
                 const char *footer, long step);
/** Something on the key map is too long and scrolls (marquee.c): redraw it every step. */
bool screen_keys_scrolls(int w, int h, const char *title, const char *const labels[10],
                         const char *footer);
/** A free Lounge phone: the takeover QR code (`url`), "SCAN TO USE THIS PHONE", a hint ("THIS
 * PHONE", "HERE: BEN", "OR PRESS A KEY") and the space's name at the bottom. */
void screen_lounge(uint8_t *fb, int w, int h, const char *url, const char *space, const char *hint);
/** The setup screen: a QR code that joins the setup network, and the same steps in words. */
void screen_setup(uint8_t *fb, int w, int h, const char *ssid, const char *pass);
