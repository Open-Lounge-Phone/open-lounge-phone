// Bodies of the signed `/fed/v1` requests. The sending server is the signature's key id; every
// `from` is one of that server's accounts, so a server can only speak for its own people.
import { z } from "zod";
import { HANDLE_RE } from "./address.ts";

export const Handle = z.string().regex(HANDLE_RE);
const Id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/** One person on the sending server: current handle, stable id, display name. */
export const Party = z.object({
  handle: Handle,
  id: Id,
  name: z.string().trim().min(1).max(64),
});
export type Party = z.infer<typeof Party>;

export const Note = z.string().trim().max(140);

/** `POST /fed/v1/knock`: a contact request. Always answered 202, whatever happens to it. */
export const KnockBody = z.object({ from: Party, to: Handle, note: Note.optional() });
/** `POST /fed/v1/connections/accept`: `from` accepts the knock `to` sent them. */
export const AcceptBody = z.object({ from: Party, to: Handle });
/** `POST /fed/v1/connections/remove`: `from` disconnected, cancelled a knock, or blocked. */
export const RemoveBody = z.object({ from: Party, to: Handle });

export type KnockBody = z.infer<typeof KnockBody>;
export type AcceptBody = z.infer<typeof AcceptBody>;
export type RemoveBody = z.infer<typeof RemoveBody>;

/** Largest JSON body accepted on `/fed/v1` (voicemail audio has its own limit). */
export const MAX_FED_BODY_BYTES = 16 * 1024;
