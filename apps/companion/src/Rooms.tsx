import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { Api, RoomMediaKind, RoomSummary } from "./api.ts";
import type { Connection, Snapshot } from "./connection.ts";
import { idleSecondsLeft, roomKindText, roomPrivacyText, whoIsIn } from "./roomText.ts";

interface Props {
  api: Api;
  conn: Connection | undefined;
  snap: Snapshot;
  guardian: boolean;
  onBack(): void;
}

/**
 * Rooms: the space's party lines (always open; drop in and out) and phone rooms (a name with an
 * address that any phone's key or anyone's app can dial). Members see who's in.
 */
export function Rooms({ api, conn, snap, guardian, onBack }: Props) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [media, setMedia] = useState<RoomMediaKind>("mesh");
  const [error, setError] = useState<string>();
  const [address, setAddress] = useState("");
  const [kind, setKind] = useState<"party" | "phone">(guardian ? "party" : "phone");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.rooms();
      setRooms(r.rooms);
      setMedia(r.media);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  const seq = snap.roomsSeq ?? 0;
  useEffect(() => {
    void seq;
    void load();
  }, [load, seq]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.createRoom({
        kind,
        name: name.trim(),
        ...(kind === "phone" ? { handle: handle.trim().toLowerCase() } : {}),
        ...(kind === "phone" && open ? { access: "connections" as const } : {}),
      });
      setName("");
      setHandle("");
    });
  };

  const inRoom = !!snap.room || !!snap.joining;
  const people = (r: RoomSummary) => snap.roomPeople?.[r.id] ?? r.people;

  return (
    <section className="card stack rooms">
      <div className="title-row">
        <button type="button" className="back" onClick={onBack}>
          ‹ Home
        </button>
        <h2>Rooms</h2>
      </div>
      <p className="hint">{roomPrivacyText(media)}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {rooms.length === 0 && <p className="muted">No rooms yet.</p>}
      <ul className="devices">
        {rooms.map((r) => (
          <li key={r.id} className="device">
            <div className="device-main">
              <div className="device-name">
                {r.name} <span className="badge">{roomKindText(r.kind)}</span>
                {r.locked && <span className="badge">Locked</span>}
              </div>
              {r.address && <div className="address small">{r.address}</div>}
              <div className="muted small">{whoIsIn(people(r))}</div>
            </div>
            <div className="device-actions">
              <button
                type="button"
                disabled={inRoom || !conn}
                onClick={() => void conn?.joinRoom({ roomId: r.id })}
              >
                Join
              </button>
              {r.mine && (
                <>
                  <button
                    type="button"
                    className="link"
                    onClick={() => void run(() => api.updateRoom(r.id, { locked: !r.locked }))}
                  >
                    {r.locked ? "Unlock" : "Lock"}
                  </button>
                  {r.kind === "phone" && (
                    <button
                      type="button"
                      className="link"
                      onClick={() =>
                        void run(() =>
                          api.updateRoom(r.id, {
                            access: r.access === "space" ? "connections" : "space",
                          }),
                        )
                      }
                    >
                      {r.access === "space" ? "Open to my connections" : "Only this space"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      if (confirm(`Delete ${r.name}? Anyone in it is taken out.`)) {
                        void run(() => api.deleteRoom(r.id));
                      }
                    }}
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (address.trim()) void conn?.joinRoom({ address: address.trim() });
        }}
      >
        <label>
          Join a phone room by address
          <input
            value={address}
            placeholder="standup@example.org"
            onChange={(e) => setAddress(e.target.value)}
            autoCapitalize="none"
          />
        </label>
        <button type="submit" disabled={inRoom || !address.trim()}>
          Join
        </button>
      </form>

      <form className="stack" onSubmit={create}>
        <h3>New room</h3>
        {guardian && (
          <div className="chips" role="radiogroup" aria-label="Kind of room">
            {(["party", "phone"] as const).map((k) => (
              <label key={k}>
                <input
                  type="radio"
                  name="room-kind"
                  checked={kind === k}
                  onChange={() => setKind(k)}
                />{" "}
                {k === "party" ? "Party line (this space, always open)" : "Phone room (an address)"}
              </label>
            ))}
          </div>
        )}
        <label>
          Name
          <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} required />
        </label>
        {kind === "phone" && (
          <>
            <label>
              Address
              <input
                value={handle}
                placeholder="standup"
                onChange={(e) => setHandle(e.target.value)}
                autoCapitalize="none"
                required
              />
            </label>
            <label>
              <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} />{" "}
              Let my connections join too (people on other servers)
            </label>
          </>
        )}
        <button type="submit" disabled={!name.trim() || (kind === "phone" && !handle.trim())}>
          Make the room
        </button>
      </form>
    </section>
  );
}

/** The room you're in: who's there, mute, leave, and the host's controls. */
export function RoomPanel({ snap, conn }: { snap: Snapshot; conn: Connection }) {
  const room = snap.room;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!room?.idleDropAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [room?.idleDropAt]);

  if (!room) {
    if (!snap.joining) return null;
    return (
      <div className="overlay" role="dialog" aria-live="polite">
        <div className="overlay-inner">
          <div className="who">Joining the room…</div>
        </div>
      </div>
    );
  }
  return (
    <div className="overlay overlay-room" role="dialog" aria-live="polite" aria-label={room.name}>
      <div className="overlay-inner stack">
        <div className="who">{room.name}</div>
        <div className="what">
          {roomKindText(room.kind)}
          {room.address ? ` · ${room.address}` : ""}
          {room.locked ? " · Locked" : ""}
          {room.connected ? "" : " · connecting…"}
        </div>
        <p className="hint small">{roomPrivacyText(room.media)}</p>
        {room.recording && (
          <div className="recording-mark" role="status">
            <span className="rec-dot" aria-hidden /> Recording · this room is recorded by{" "}
            {room.recording}
          </div>
        )}
        {room.idleDropAt && (
          <div className="warning" role="alert">
            Still there? You'll leave in {idleSecondsLeft(room.idleDropAt, now)} s.{" "}
            <button type="button" onClick={() => conn.stillHere()}>
              I'm here
            </button>
          </div>
        )}
        <ul className="room-people">
          {room.participants.map((p) => (
            <li key={p.id} className={`person${p.speaking ? " speaking" : ""}`}>
              <span className={`dot${p.speaking ? " ok" : ""}`} aria-hidden />
              <span>
                {p.name}
                {p.id === room.you ? " (you)" : ""}
                {p.remote ? ` · ${p.remote}` : ""}
              </span>
              {p.host && <span className="badge">Host</span>}
              {p.muted && <span className="badge">Muted</span>}
              {room.host && p.id !== room.you && (
                <span className="row">
                  {!p.muted && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => conn.muteParticipant(p.id)}
                    >
                      Mute
                    </button>
                  )}
                  <button
                    type="button"
                    className="link"
                    onClick={() => conn.removeParticipant(p.id)}
                  >
                    Remove
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
        <div className="overlay-actions">
          <button
            type="button"
            className={`round mute ${snap.muted ? "on" : ""}`}
            aria-pressed={snap.muted}
            onClick={() => conn.toggleMute()}
          >
            {snap.muted ? "Unmute" : "Mute"}
          </button>
          {room.host && room.kind !== "call" && (
            <button type="button" className="round" onClick={() => conn.lockRoom(!room.locked)}>
              {room.locked ? "Unlock" : "Lock"}
            </button>
          )}
          <button type="button" className="round decline" onClick={() => conn.leaveRoom()}>
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}
