#pragma once
#include <stdbool.h>
#include "cJSON.h"

#define PROTOCOL_VERSION 1
#define MAX_MESSAGE_BYTES 16384

/** Serialize, log and send one message, then free it. Returns false if not sent. */
bool proto_send(cJSON *msg);
/** Keep-alive, byte for byte as the protocol asks (hibernating servers answer it unwoken). */
bool proto_ping(void);
