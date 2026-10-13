// The USB macro pad (labs): in macro mode the phone is a USB keyboard on the computer it's
// plugged into (keyboard keys + media keys). TinyUSB then owns the USB port, so the console isn't
// on USB in that mode (flash with BOOT held if needed).
#pragma once
#include <stdbool.h>

#include "labs_hid.h"

bool labs_usb_start(void);
bool labs_usb_ready(void);
/** Press and release a combo. */
void labs_usb_send(const hid_combo_t *c);
