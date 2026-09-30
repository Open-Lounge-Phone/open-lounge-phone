#pragma once
#include <stdbool.h>
/** Probe the ES8311 on I2C and put it in a known state. v0: no audio path yet. */
bool codec_init(void);
