// Protocol compatibility with the server (docs/protocol.md "Versions and compatibility"): what a
// server message says about whether this phone and the server can talk, and what to show if not.
// Pure (cJSON only), so the host tests cover it.
#pragma once
#include <stdbool.h>
#include "cJSON.h"

typedef enum {
  COMPAT_OK,
  /** The server no longer accepts this phone's protocol: the phone needs new firmware. */
  COMPAT_UPDATE_NEEDED,
  /** The server is older than this phone's protocol: the server needs an update. */
  COMPAT_SERVER_TOO_OLD,
} compat_t;

/**
 * What one server message says: `config` with `update`, or `error` `unsupported_version`
 * (with `server.protocol` when the server sends it). Everything else is COMPAT_OK; unknown
 * fields and messages are ignored.
 */
compat_t compat_from_message(const cJSON *m, int our_protocol);

/** The two status lines (at most 24 characters each) for a refusal. */
void compat_lines(compat_t c, char lines[2][25]);
