// What this server is: its software version (the root package.json `version`; a test keeps them
// equal), the federation versions and features it advertises in `.well-known`, and the device
// protocol range and features it tells phones and apps about.
import { FEATURE_NAMES, type Feature, SUPPORTED_VERSIONS } from "@openloungephone/federation";
import {
  DEVICE_FEATURES,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type ServerInfo,
} from "@openloungephone/protocol";

/** Released as git tag `server-v<SERVER_VERSION>`. */
export const SERVER_VERSION = "0.2.0";
export const SOFTWARE = `openloungephone/${SERVER_VERSION}`;

/** Federation features this server implements (all of the registry). */
export const OWN_FEATURES: readonly Feature[] = FEATURE_NAMES;

export { SUPPORTED_VERSIONS };

/** What phones and apps are told about this server (`config.server`, `app.ready.server`). */
export const SERVER_INFO: ServerInfo = {
  software: SOFTWARE,
  protocol: { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION },
  features: [...DEVICE_FEATURES],
};
