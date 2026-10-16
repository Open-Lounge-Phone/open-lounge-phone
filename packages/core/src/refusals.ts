// Why a call didn't go through, in plain words: `call.state ended` carries one of these as its
// `note`, so the apps say it and phones show a short line for it instead of a bare BUSY.
//
// No enumeration: someone who may not call an address learns only CANT_CALL_NOTE, the same
// whether anything is there or not. An add-on's owner and the people it was shared with may
// learn more (it isn't connected, it takes no calls, it's full), and an owner calling their own
// handle learns that no add-on of that name is linked here.

/** The caller is already on a call (not the other side being busy). */
export const CALLER_BUSY_NOTE = "You're already on a call";
/** An add-on you may call isn't connected to its server right now. */
export const ADDON_OFFLINE_NOTE = "That add-on isn't connected right now";
/** An add-on you may call said it doesn't take calls. */
export const ADDON_NO_CALLS_NOTE = "That add-on doesn't take calls";
/** An add-on you may call is on as many calls as it takes. */
export const ADDON_FULL_NOTE = "That add-on is on as many calls as it takes";
/** Your own handle, but no add-on by that name is linked to your account on that server. */
export const ADDON_NOT_LINKED_NOTE = "You have no add-on by that name on that server";
/** The server the add-on would be on has add-ons turned off. */
export const ADDONS_OFF_NOTE = "Add-ons are off on that server";
/** Nothing you may call at that address (whether or not anything is there). */
export const CANT_CALL_NOTE = "You can't call that address";

/** What a phone's two status lines say for a refusal note (16 characters each), if known. */
const STATUS: Record<string, [string, string]> = {
  [CALLER_BUSY_NOTE]: ["ON ANOTHER CALL", "PRESS A KEY"],
  [ADDON_OFFLINE_NOTE]: ["ADD-ON OFFLINE", "PRESS A KEY"],
  [ADDON_NO_CALLS_NOTE]: ["TAKES NO CALLS", "PRESS A KEY"],
  [ADDON_FULL_NOTE]: ["ADD-ON BUSY", "PRESS A KEY"],
  [ADDON_NOT_LINKED_NOTE]: ["NO SUCH ADD-ON", "PRESS A KEY"],
  [ADDONS_OFF_NOTE]: ["ADD-ONS ARE OFF", "PRESS A KEY"],
  [CANT_CALL_NOTE]: ["CAN'T CALL THAT", "PRESS A KEY"],
};

export const refusalStatus = (note: string | undefined): [string, string] | undefined =>
  note === undefined ? undefined : STATUS[note];

/** Every refusal note a phone has a status line for (firmware mirrors this table). */
export const REFUSAL_NOTES: readonly string[] = Object.keys(STATUS);
