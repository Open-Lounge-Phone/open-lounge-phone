// Labs glue: hooks the phone's main loop calls in the labs build (CONFIG_OLP_LABS).
#pragma once
#include <stdbool.h>
#include <stdint.h>

void labs_start(void);                               // at boot: settings, check-in state
void labs_net_up(void);                              // Wi-Fi up: intercom sockets, settings page
/** A key with the menu closed (digits 0-9 protocol order, 11 BACK). True = labs handled it. */
bool labs_key(int index, bool hook_up, int64_t now);
/** The hook. True = the intercom took it (the phone's own call logic leaves it alone). */
bool labs_hook(bool up, int64_t now);
void labs_tick(int64_t now);
/** EV_LABS from the labs tasks: "M|ip|line", "N|line1|line2", "S|status" (frees data). */
void labs_event(int a, char *data, int64_t now);
/** Screen lines for the labs modes and the intercom (0 = the phone's own). */
int labs_lines(char out[2][41], bool idle, bool offhook, int64_t now);
/** The key map label for a digit key, or NULL to keep the phone's. */
const char *labs_label(int index);
bool labs_busy(void);                                // the intercom is ringing / calling / talking
bool labs_ringing(void);
int labs_menu_lines(char out[6][25]);
/** A labs mode (not "phone") is set: it works without a server, so no "choose a server" screen. */
bool labs_standalone(void);
