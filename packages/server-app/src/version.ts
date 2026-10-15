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
export const SERVER_VERSION = "0.8.0";
export const SOFTWARE = `openloungephone/${SERVER_VERSION}`;

/** Federation features this server implements (all of the registry). */
export const OWN_FEATURES: readonly Feature[] = FEATURE_NAMES;

/** Features that exist only while the operator has add-ons on. */
const ADDON_FEATURES: readonly string[] = ["addons", "addon-shares"];

/**
 * What this server advertises in `.well-known`: everything it implements, but `addons` and
 * `addon-shares` only when its operator turned add-ons on (`ADDONS=on`), so other servers never
 * offer it add-on calls or share grants otherwise.
 */
export const advertisedFeatures = (env: { addons?: boolean }): Feature[] =>
  OWN_FEATURES.filter((f) => !ADDON_FEATURES.includes(f) || env.addons === true);

export { SUPPORTED_VERSIONS };

/** What phones and apps are told about this server (`config.server`, `app.ready.server`). */
export const SERVER_INFO: ServerInfo = {
  software: SOFTWARE,
  protocol: { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION },
  features: DEVICE_FEATURES.filter((f) => !ADDON_FEATURES.includes(f)),
};

/** `SERVER_INFO` as this server tells it: with `addons` (and `addon-shares`) when add-ons are on. */
export const serverInfo = (env: { addons?: boolean }): ServerInfo =>
  env.addons === true ? { ...SERVER_INFO, features: [...DEVICE_FEATURES] } : SERVER_INFO;
