"use client";

import { useState } from "react";
import Link from "next/link";

type Room = { name: string; apartments: string; guests: string; floor: string; base: string; ceiling: string; bdc_room_code: string };
type Step = { step: string; ok: boolean; detail: string };

const blank: Room = { name: "", apartments: "", guests: "2", floor: "", base: "", ceiling: "", bdc_room_code: "" };

/**
 * Everything a new Booking.com listing needs, on one screen. Approve Channex.io
 * as the connectivity provider in the extranet first; the rest happens here.
 */
export default function NewListingForm() {
  const [name, setName] = useState("");
  const [hotelId, setHotelId] = useState("");
  const [rooms, setRooms] = useState<Room[]>([{ ...blank }]);
  const [activate, setActivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [live, setLive] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const edit = (i: number, field: keyof Room, value: string) =>
    setRooms((rs) => rs.map((r, j) => (j === i ? { ...r, [field]: value } : r)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSteps([]);
    setLive(null);
    setError(null);
    try {
      const res = await fetch("/api/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          hotel_id: hotelId,
          activate,
          room_types: rooms.map((r) => ({
            name: r.name,
            apartments: r.apartments.split(/[\s,]+/).filter(Boolean),
            guests: Number(r.guests),
            floor: Number(r.floor),
            base: Number(r.base),
            ceiling: Number(r.ceiling),
            bdc_room_code: r.bdc_room_code || undefined,
          })),
        }),
      });
      const out = await res.json();
      if (out.error) setError(out.error);
      setSteps(out.steps ?? []);
      setLive(out.live ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const field = { width: "100%", padding: "8px 10px" } as const;

  return (
    <div className="card" style={{ maxWidth: 760 }}>
      <p><Link href="/">Back</Link></p>
      <h2>Add a Booking.com listing</h2>
      <p className="lede">
        Approve Channex.io as the connectivity provider in the Booking.com extranet first, and set each room to the
        number of guests you price for. Then fill this in. Prices are what Victory Suites keeps per night; commission
        and tourist tax are added on top.
      </p>
      <form onSubmit={submit}>
        <label>Listing name</label>
        <input style={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Victory Suites Studios" />
        <label style={{ display: "block", marginTop: 10 }}>Booking.com hotel ID</label>
        <input style={field} value={hotelId} onChange={(e) => setHotelId(e.target.value)} placeholder="16556651" />

        {rooms.map((r, i) => (
          <div key={i} className="card" style={{ marginTop: 14, background: "var(--surface-2)" }}>
            <strong>Room type {i + 1}</strong>
            <label style={{ display: "block", marginTop: 8 }}>Name</label>
            <input style={field} value={r.name} onChange={(e) => edit(i, "name", e.target.value)} placeholder="Studio" />
            <label style={{ display: "block", marginTop: 8 }}>Apartments, comma separated</label>
            <input style={field} value={r.apartments} onChange={(e) => edit(i, "apartments", e.target.value)} placeholder="1.02, 6.02" />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 8 }}>
              <div><label>Guests</label><input style={field} value={r.guests} onChange={(e) => edit(i, "guests", e.target.value)} /></div>
              <div><label>Floor £</label><input style={field} value={r.floor} onChange={(e) => edit(i, "floor", e.target.value)} /></div>
              <div><label>Base £</label><input style={field} value={r.base} onChange={(e) => edit(i, "base", e.target.value)} /></div>
              <div><label>Ceiling £</label><input style={field} value={r.ceiling} onChange={(e) => edit(i, "ceiling", e.target.value)} /></div>
            </div>
            {rooms.length > 1 ? (
              <>
                <label style={{ display: "block", marginTop: 8 }}>Booking.com room code (only when the listing has several rooms)</label>
                <input style={field} value={r.bdc_room_code} onChange={(e) => edit(i, "bdc_room_code", e.target.value)} />
              </>
            ) : null}
          </div>
        ))}
        <p style={{ marginTop: 10 }}>
          <button type="button" onClick={() => setRooms((rs) => [...rs, { ...blank }])}>Add another room type</button>
        </p>
        <label style={{ display: "block", margin: "12px 0" }}>
          <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} /> Put it live straight away
        </label>
        <button type="submit" disabled={busy || !name || !hotelId}>{busy ? "Working, up to two minutes" : "Add listing"}</button>
      </form>

      {error ? <p style={{ color: "var(--danger)", marginTop: 14 }} role="alert">{error}</p> : null}
      {steps.length ? (
        <ol style={{ marginTop: 14 }}>
          {steps.map((s, i) => (
            <li key={i} style={{ color: s.ok ? "var(--text)" : "var(--danger)", marginBottom: 6 }}>
              <strong>{s.step}</strong>: {s.detail}
            </li>
          ))}
        </ol>
      ) : null}
      {live === true ? <p style={{ color: "var(--secondary)" }}>Live on Booking.com.</p> : null}
    </div>
  );
}
