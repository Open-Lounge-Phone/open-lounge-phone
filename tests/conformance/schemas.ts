// The v1 schemas the snapshots freeze: every federation body, query, response and stream frame,
// `.well-known`, and the four device/app message unions.
import * as fed from "@openloungephone/federation";
import {
  AppToServer,
  DeviceToServer,
  ServerInfo,
  ServerToApp,
  ServerToDevice,
} from "@openloungephone/protocol";
import type { z } from "zod";
import { type JsonSchema, snapshotOf } from "./schemaCompat.ts";

export const FEDERATION_SCHEMAS: Record<string, z.ZodType> = {
  WellKnown: fed.WellKnown,
  KeyRotation: fed.KeyRotation,
  Party: fed.Party,
  KnockBody: fed.KnockBody,
  AcceptBody: fed.AcceptBody,
  RemoveBody: fed.RemoveBody,
  Accepted: fed.Accepted,
  FedErrorBody: fed.FedErrorBody,
  CallTarget: fed.CallTarget,
  CallBody: fed.CallBody,
  CallResult: fed.CallResult,
  PresenceBody: fed.PresenceBody,
  PhonesBody: fed.PhonesBody,
  LoungeClaimBody: fed.LoungeClaimBody,
  LoungeClaimResult: fed.LoungeClaimResult,
  LoungeProgressBody: fed.LoungeProgressBody,
  LoungeDialBody: fed.LoungeDialBody,
  LoungeLeaveBody: fed.LoungeLeaveBody,
  GreetingBody: fed.GreetingBody,
  VoicemailQuery: fed.VoicemailQuery,
  StreamQuery: fed.StreamQuery,
  StreamHello: fed.StreamHello,
  StreamSignal: fed.StreamSignal,
  StreamUnsupported: fed.StreamUnsupported,
  RoomJoinBody: fed.RoomJoinBody,
  RoomJoinResult: fed.RoomJoinResult,
  LineCallbackBody: fed.LineCallbackBody,
  LineCallbackMissedBody: fed.LineCallbackMissedBody,
  LineCallbackMissedResult: fed.LineCallbackMissedResult,
};

export const PROTOCOL_SCHEMAS: Record<string, z.ZodType> = {
  DeviceToServer,
  ServerToDevice,
  AppToServer,
  ServerToApp,
  ServerInfo,
};

/**
 * Enum values and union variants added within v1 behind a federation feature (`compare`'s
 * `gated`), by schema.
 */
export const GATED: Record<string, string[]> = {
  // Feature `public-lines`: the `line` call target.
  CallTarget: ["#line"],
  CallBody: ["to#line"],
};

export const snapshotAll = (schemas: Record<string, z.ZodType>): Record<string, JsonSchema> =>
  Object.fromEntries(Object.entries(schemas).map(([k, s]) => [k, snapshotOf(s)]));
