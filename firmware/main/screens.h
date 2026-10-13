// Pixel screens beyond text: the boot logo and the setup QR code (docs/phone-ux.md).
#pragma once
#include <stdint.h>

/** The boot screen: the mark and "OPEN LOUNGE PHONE", the firmware version small. */
void screen_boot(uint8_t *fb, int w, int h, const char *version);
/** The setup screen: a QR code that joins the setup network, and the same steps in words. */
void screen_setup(uint8_t *fb, int w, int h, const char *ssid, const char *pass);
