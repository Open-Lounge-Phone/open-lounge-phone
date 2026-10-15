// Home features on the phones (migration 0030): daily check-in, chime, house intercom. Per phone,
// off by default; the space's intercom key is made when a phone first turns the intercom on.
import { newToken } from "./crypto.ts";
import type { Sql } from "./sql.ts";

export interface HomeFeatures {
  /** Daily check-in by this local time (`HH:MM`); null = off. */
  checkinBy: string | null;
  /** The last local day (`YYYY-MM-DD`) someone pressed I'm OK, and the last day it alerted. */
  checkinOkDay: string | null;
  checkinAlertDay: string | null;
  /** The words the phone may post as a notice to every phone of its space; null = off. */
  chimeText: string | null;
  intercom: boolean;
}

type Row = {
  checkin_by: string | null;
  checkin_ok_day: string | null;
  checkin_alert_day: string | null;
  chime_text: string | null;
  intercom: number;
};

const OFF: HomeFeatures = {
  checkinBy: null,
  checkinOkDay: null,
  checkinAlertDay: null,
  chimeText: null,
  intercom: false,
};

export class HomeStore {
  private readonly sql: Sql;
  constructor(sql: Sql) {
    this.sql = sql;
  }

  async get(deviceId: string): Promise<HomeFeatures> {
    const r = await this.sql.first<Row>(
      `SELECT checkin_by, checkin_ok_day, checkin_alert_day, chime_text, intercom
       FROM devices WHERE id = ?`,
      deviceId,
    );
    if (!r) return OFF;
    return {
      checkinBy: r.checkin_by,
      checkinOkDay: r.checkin_ok_day,
      checkinAlertDay: r.checkin_alert_day,
      chimeText: r.chime_text,
      intercom: r.intercom === 1,
    };
  }

  /** Phones of a space with a daily check-in set. */
  async checkins(householdId: string): Promise<({ deviceId: string } & HomeFeatures)[]> {
    const rows = await this.sql.all<Row & { id: string }>(
      `SELECT id, checkin_by, checkin_ok_day, checkin_alert_day, chime_text, intercom
       FROM devices WHERE household_id = ? AND checkin_by IS NOT NULL`,
      householdId,
    );
    return rows.map((r) => ({
      deviceId: r.id,
      checkinBy: r.checkin_by,
      checkinOkDay: r.checkin_ok_day,
      checkinAlertDay: r.checkin_alert_day,
      chimeText: r.chime_text,
      intercom: r.intercom === 1,
    }));
  }

  async set(
    deviceId: string,
    patch: { checkinBy?: string | null; chimeText?: string | null; intercom?: boolean },
  ): Promise<void> {
    if (patch.checkinBy !== undefined) {
      // A new time starts afresh: today isn't counted as missed for the old one.
      await this.sql.run(
        "UPDATE devices SET checkin_by = ?, checkin_alert_day = NULL WHERE id = ?",
        patch.checkinBy,
        deviceId,
      );
    }
    if (patch.chimeText !== undefined) {
      await this.sql.run(
        "UPDATE devices SET chime_text = ? WHERE id = ?",
        patch.chimeText,
        deviceId,
      );
    }
    if (patch.intercom !== undefined) {
      await this.sql.run(
        "UPDATE devices SET intercom = ? WHERE id = ?",
        patch.intercom ? 1 : 0,
        deviceId,
      );
    }
  }

  async checkedIn(deviceId: string, day: string): Promise<void> {
    await this.sql.run("UPDATE devices SET checkin_ok_day = ? WHERE id = ?", day, deviceId);
  }

  /** Marks today's alert sent; false if it already was (only one a day). */
  async alerted(deviceId: string, day: string): Promise<boolean> {
    const r = await this.sql.run(
      `UPDATE devices SET checkin_alert_day = ?
       WHERE id = ? AND (checkin_alert_day IS NULL OR checkin_alert_day != ?)`,
      day,
      deviceId,
      day,
    );
    return r.changes > 0;
  }

  /** The space's intercom key, made on first use (32 random bytes, base64url). */
  async intercomKey(householdId: string): Promise<string> {
    await this.sql.run(
      "UPDATE households SET intercom_key = ? WHERE id = ? AND intercom_key IS NULL",
      newToken(),
      householdId,
    );
    const r = await this.sql.first<{ k: string | null }>(
      "SELECT intercom_key AS k FROM households WHERE id = ?",
      householdId,
    );
    return r?.k ?? "";
  }
}
