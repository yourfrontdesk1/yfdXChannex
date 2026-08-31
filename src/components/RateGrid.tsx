"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { addDays, dayNumber, isWeekend, monthLabel, weekday } from "@/lib/dates";
import type { AriRow, EditableField, Property, RatePlan, RoomType } from "@/lib/types";

type Props = {
  property: Property;
  roomTypes: RoomType[];
  ratePlans: RatePlan[];
  ari: AriRow[];
  dates: string[];
  start: string;
  days: number;
  pendingOutbox: number;
};

type EditValue = string | boolean | null;

const NUMERIC_ROWS: { field: EditableField; label: string }[] = [
  { field: "rate", label: "Rate" },
  { field: "min_stay_through", label: "Min stay through" },
  { field: "min_stay_arrival", label: "Min stay on arrival" },
  { field: "max_stay", label: "Max stay" },
];

const TOGGLE_ROWS: { field: EditableField; label: string; danger?: boolean }[] = [
  { field: "closed_to_arrival", label: "Closed to arrival" },
  { field: "closed_to_departure", label: "Closed to departure" },
  { field: "stop_sell", label: "Stop sell", danger: true },
];

function cellKey(roomTypeId: string, ratePlanId: string | null, date: string, field: EditableField) {
  return [roomTypeId, ratePlanId ?? "-", date, field].join("|");
}

export default function RateGrid({
  property,
  roomTypes,
  ratePlans,
  ari,
  dates,
  start,
  days,
  pendingOutbox,
}: Props) {
  const router = useRouter();
  const [edits, setEdits] = useState<Record<string, EditValue>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [showRestrictions, setShowRestrictions] = useState(true);

  const base = useMemo(() => {
    const map = new Map<string, AriRow>();
    for (const row of ari) {
      map.set([row.room_type_id, row.rate_plan_id ?? "-", row.date].join("|"), row);
    }
    return map;
  }, [ari]);

  const plansByRoomType = useMemo(() => {
    const map = new Map<string, RatePlan[]>();
    for (const plan of ratePlans) {
      const list = map.get(plan.room_type_id) ?? [];
      list.push(plan);
      map.set(plan.room_type_id, list);
    }
    return map;
  }, [ratePlans]);

  function stored(roomTypeId: string, ratePlanId: string | null, date: string, field: EditableField) {
    const row = base.get([roomTypeId, ratePlanId ?? "-", date].join("|"));
    if (!row) return null;
    return (row as unknown as Record<string, unknown>)[field] ?? null;
  }

  function current(roomTypeId: string, ratePlanId: string | null, date: string, field: EditableField): EditValue {
    const k = cellKey(roomTypeId, ratePlanId, date, field);
    if (k in edits) return edits[k];
    const value = stored(roomTypeId, ratePlanId, date, field);
    if (value === null || value === undefined) return "";
    if (typeof value === "boolean") return value;
    return String(value);
  }

  function setCell(
    roomTypeId: string,
    ratePlanId: string | null,
    date: string,
    field: EditableField,
    value: EditValue,
  ) {
    setEdits((prev) => ({ ...prev, [cellKey(roomTypeId, ratePlanId, date, field)]: value }));
    setMessage(null);
  }

  const editCount = Object.keys(edits).length;

  async function save() {
    if (editCount === 0) return;
    setSaving(true);
    setMessage(null);
    try {
      const payload = Object.entries(edits).map(([k, value]) => {
        const [room_type_id, rp, date, field] = k.split("|");
        return {
          room_type_id,
          rate_plan_id: rp === "-" ? null : rp,
          date,
          field: field as EditableField,
          value,
        };
      });
      const res = await fetch("/api/ari", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ property_id: property.id, edits: payload }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Save failed");
      setEdits({});
      setMessage({
        text: `Saved ${body.rows} cells and queued ${body.queued} deltas for Channex.`,
        tone: "ok",
      });
      router.refresh();
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), tone: "err" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1>{property.name}</h1>
      <p className="lede">
        Change a cell and it lands in the outbox on the write itself. The worker
        batches whatever is waiting into as few Channex calls as the range allows.
      </p>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="row">
            <label className="field">
              From
              <input
                type="date"
                defaultValue={start}
                onChange={(e) => {
                  if (e.target.value) router.push(`/grid/${property.id}?start=${e.target.value}&days=${days}`);
                }}
              />
            </label>
            <label className="field">
              Days
              <select
                defaultValue={String(days)}
                onChange={(e) => router.push(`/grid/${property.id}?start=${start}&days=${e.target.value}`)}
              >
                {[14, 30, 60, 90, 120].map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              &nbsp;
              <button className="ghost" onClick={() => router.push(`/grid/${property.id}?start=${addDays(start, -days)}&days=${days}`)}>
                Earlier
              </button>
            </label>
            <label className="field">
              &nbsp;
              <button className="ghost" onClick={() => router.push(`/grid/${property.id}?start=${addDays(start, days)}&days=${days}`)}>
                Later
              </button>
            </label>
            <label className="field">
              &nbsp;
              <button className="ghost" onClick={() => setShowRestrictions((v) => !v)}>
                {showRestrictions ? "Hide restrictions" : "Show restrictions"}
              </button>
            </label>
          </div>
          <div className="row">
            <span className="pill">{monthLabel(start)}</span>
            <span className={pendingOutbox > 0 ? "pill pending" : "pill live"}>
              {pendingOutbox > 0 ? `${pendingOutbox} waiting in outbox` : "outbox clear"}
            </span>
          </div>
        </div>
      </div>

      <BulkBar
        roomTypes={roomTypes}
        plansByRoomType={plansByRoomType}
        dates={dates}
        onApply={(targets) => {
          setEdits((prev) => {
            const next = { ...prev };
            for (const t of targets) next[cellKey(t.roomTypeId, t.ratePlanId, t.date, t.field)] = t.value;
            return next;
          });
          setMessage(null);
        }}
      />

      <div className="gridwrap">
        <table className="grid">
          <thead>
            <tr>
              <th className="label">Room type</th>
              {dates.map((d) => (
                <th key={d} className={isWeekend(d) ? "weekend" : undefined}>
                  {weekday(d)}
                  <span className="dnum">{dayNumber(d)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {roomTypes.map((rt) => {
              const plans = plansByRoomType.get(rt.id) ?? [];
              return (
                <RoomTypeBlock
                  key={rt.id}
                  roomType={rt}
                  plans={plans}
                  dates={dates}
                  showRestrictions={showRestrictions}
                  current={current}
                  setCell={setCell}
                  isDirty={(rtId, rpId, date, field) => cellKey(rtId, rpId, date, field) in edits}
                />
              );
            })}
            {roomTypes.length === 0 && (
              <tr>
                <td className="label">No room types on this property yet</td>
                {dates.map((d) => (
                  <td key={d} className="cell" />
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="savebar">
        <button className="primary" onClick={save} disabled={saving || editCount === 0}>
          {saving ? "Saving" : "Save and queue"}
        </button>
        <span className="count">{editCount === 0 ? "No pending edits" : `${editCount} edited cells`}</span>
        {editCount > 0 && (
          <button className="ghost" onClick={() => setEdits({})} disabled={saving}>
            Discard
          </button>
        )}
        {message && <span className={`msg ${message.tone}`}>{message.text}</span>}
      </div>

      <p className="legend">
        Availability is held on the room type. Rate and every restriction is held
        on the rate plan, which is how Channex expects them and how the batching
        splits into one availability call and one rates call.
      </p>
    </>
  );
}

function RoomTypeBlock({
  roomType,
  plans,
  dates,
  showRestrictions,
  current,
  setCell,
  isDirty,
}: {
  roomType: RoomType;
  plans: RatePlan[];
  dates: string[];
  showRestrictions: boolean;
  current: (rt: string, rp: string | null, d: string, f: EditableField) => EditValue;
  setCell: (rt: string, rp: string | null, d: string, f: EditableField, v: EditValue) => void;
  isDirty: (rt: string, rp: string | null, d: string, f: EditableField) => boolean;
}) {
  return (
    <>
      <tr className="group">
        <td className="label">
          {roomType.name} <span className="pill">{roomType.count_of_rooms} units</span>
        </td>
        {dates.map((d) => (
          <td key={d} />
        ))}
      </tr>

      <tr>
        <td className="label">Rooms free</td>
        {dates.map((d) => {
          const v = current(roomType.id, null, d, "availability");
          const dirty = isDirty(roomType.id, null, d, "availability");
          return (
            <td
              key={d}
              className={[
                "cell",
                isWeekend(d) ? "weekend" : "",
                dirty ? "dirty" : "",
                v === "0" ? "zero" : "",
              ].filter(Boolean).join(" ")}
            >
              <input
                inputMode="numeric"
                value={typeof v === "boolean" ? "" : v ?? ""}
                onChange={(e) => setCell(roomType.id, null, d, "availability", e.target.value.replace(/[^0-9]/g, ""))}
              />
            </td>
          );
        })}
      </tr>

      {plans.map((plan) => (
        <PlanRows
          key={plan.id}
          roomType={roomType}
          plan={plan}
          dates={dates}
          showRestrictions={showRestrictions}
          current={current}
          setCell={setCell}
          isDirty={isDirty}
        />
      ))}
    </>
  );
}

function PlanRows({
  roomType,
  plan,
  dates,
  showRestrictions,
  current,
  setCell,
  isDirty,
}: {
  roomType: RoomType;
  plan: RatePlan;
  dates: string[];
  showRestrictions: boolean;
  current: (rt: string, rp: string | null, d: string, f: EditableField) => EditValue;
  setCell: (rt: string, rp: string | null, d: string, f: EditableField, v: EditValue) => void;
  isDirty: (rt: string, rp: string | null, d: string, f: EditableField) => boolean;
}) {
  const numericRows = showRestrictions ? NUMERIC_ROWS : NUMERIC_ROWS.slice(0, 1);

  return (
    <>
      <tr className="planhead">
        <td className="label">
          {plan.name} <span className="pill">sleeps {plan.occupancy}</span>
        </td>
        {dates.map((d) => (
          <td key={d} />
        ))}
      </tr>

      {numericRows.map(({ field, label }) => (
        <tr key={field}>
          <td className="label">{label}</td>
          {dates.map((d) => {
            const v = current(roomType.id, plan.id, d, field);
            const dirty = isDirty(roomType.id, plan.id, d, field);
            return (
              <td
                key={d}
                className={["cell", isWeekend(d) ? "weekend" : "", dirty ? "dirty" : ""].filter(Boolean).join(" ")}
              >
                <input
                  inputMode="decimal"
                  value={typeof v === "boolean" ? "" : v ?? ""}
                  onChange={(e) => {
                    const clean =
                      field === "rate"
                        ? e.target.value.replace(/[^0-9.]/g, "")
                        : e.target.value.replace(/[^0-9]/g, "");
                    setCell(roomType.id, plan.id, d, field, clean);
                  }}
                />
              </td>
            );
          })}
        </tr>
      ))}

      {showRestrictions &&
        TOGGLE_ROWS.map(({ field, label, danger }) => (
          <tr key={field}>
            <td className="label">{label}</td>
            {dates.map((d) => {
              const raw = current(roomType.id, plan.id, d, field);
              const on = raw === true || raw === "true";
              const dirty = isDirty(roomType.id, plan.id, d, field);
              return (
                <td
                  key={d}
                  className={[
                    "cell",
                    "toggle",
                    on ? "on" : "",
                    on && danger ? "stop" : "",
                    isWeekend(d) ? "weekend" : "",
                    dirty ? "dirty" : "",
                  ].filter(Boolean).join(" ")}
                  onClick={() => setCell(roomType.id, plan.id, d, field, !on)}
                  title={`${label} on ${d}`}
                >
                  {on ? "yes" : ""}
                </td>
              );
            })}
          </tr>
        ))}
    </>
  );
}

function BulkBar({
  roomTypes,
  plansByRoomType,
  dates,
  onApply,
}: {
  roomTypes: RoomType[];
  plansByRoomType: Map<string, RatePlan[]>;
  dates: string[];
  onApply: (
    targets: { roomTypeId: string; ratePlanId: string | null; date: string; field: EditableField; value: EditValue }[],
  ) => void;
}) {
  const [roomTypeId, setRoomTypeId] = useState<string>("all");
  const [field, setField] = useState<EditableField>("rate");
  const [from, setFrom] = useState(dates[0]);
  const [to, setTo] = useState(dates[Math.min(6, dates.length - 1)]);
  const [value, setValue] = useState("");

  const isToggle = TOGGLE_ROWS.some((t) => t.field === field);
  const isAvailability = field === "availability";

  function apply() {
    const window = dates.filter((d) => d >= from && d <= to);
    const targetRoomTypes = roomTypeId === "all" ? roomTypes : roomTypes.filter((r) => r.id === roomTypeId);
    const out: { roomTypeId: string; ratePlanId: string | null; date: string; field: EditableField; value: EditValue }[] = [];

    for (const rt of targetRoomTypes) {
      if (isAvailability) {
        for (const d of window) out.push({ roomTypeId: rt.id, ratePlanId: null, date: d, field, value });
        continue;
      }
      for (const plan of plansByRoomType.get(rt.id) ?? []) {
        for (const d of window) {
          out.push({
            roomTypeId: rt.id,
            ratePlanId: plan.id,
            date: d,
            field,
            value: isToggle ? value === "yes" : value,
          });
        }
      }
    }
    onApply(out);
  }

  return (
    <div className="card">
      <h2>Set a range</h2>
      <div className="row">
        <label className="field">
          Room type
          <select value={roomTypeId} onChange={(e) => setRoomTypeId(e.target.value)}>
            <option value="all">Every room type</option>
            {roomTypes.map((rt) => (
              <option key={rt.id} value={rt.id}>
                {rt.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          What
          <select value={field} onChange={(e) => setField(e.target.value as EditableField)}>
            <option value="availability">Rooms free</option>
            {NUMERIC_ROWS.map((r) => (
              <option key={r.field} value={r.field}>
                {r.label}
              </option>
            ))}
            {TOGGLE_ROWS.map((r) => (
              <option key={r.field} value={r.field}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          From
          <input type="date" value={from} min={dates[0]} max={dates[dates.length - 1]} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          To
          <input type="date" value={to} min={dates[0]} max={dates[dates.length - 1]} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="field">
          Value
          {isToggle ? (
            <select value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="no">no</option>
              <option value="yes">yes</option>
            </select>
          ) : (
            <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder={field === "rate" ? "98" : "2"} />
          )}
        </label>
        <label className="field">
          &nbsp;
          <button onClick={apply}>Apply to grid</button>
        </label>
      </div>
      <p className="legend">
        Applying fills the cells but does not send anything. Save is what writes
        the rows and queues the deltas.
      </p>
    </div>
  );
}
