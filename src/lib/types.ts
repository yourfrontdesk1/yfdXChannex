export type Account = {
  id: string;
  name: string;
  slug: string;
  channex_group_id: string | null;
  is_active: boolean;
};

export type Property = {
  id: string;
  account_id: string;
  name: string;
  currency: string;
  timezone: string;
  channex_property_id: string | null;
  downstream_url: string | null;
  is_active: boolean;
};

export type RoomType = {
  id: string;
  property_id: string;
  name: string;
  count_of_rooms: number;
  occ_adults: number;
  occ_children: number;
  occ_infants: number;
  default_occupancy: number;
  channex_room_type_id: string | null;
  sort: number;
};

export type RatePlan = {
  id: string;
  room_type_id: string;
  name: string;
  occupancy: number;
  channex_rate_plan_id: string | null;
  is_primary: boolean;
};

export type AriRow = {
  id?: string;
  property_id: string;
  room_type_id: string;
  rate_plan_id: string | null;
  date: string;
  availability: number | null;
  rate: string | number | null;
  min_stay_through: number | null;
  min_stay_arrival: number | null;
  max_stay: number | null;
  closed_to_arrival: boolean | null;
  closed_to_departure: boolean | null;
  stop_sell: boolean | null;
};

/** One edit made in the grid. The API turns a batch of these into upserts. */
export type CellEdit = {
  room_type_id: string;
  rate_plan_id: string | null;
  date: string;
  field: EditableField;
  value: number | boolean | null;
};

export type EditableField =
  | "availability"
  | "rate"
  | "min_stay_through"
  | "min_stay_arrival"
  | "max_stay"
  | "closed_to_arrival"
  | "closed_to_departure"
  | "stop_sell";

export const EDITABLE_FIELDS: EditableField[] = [
  "availability",
  "rate",
  "min_stay_through",
  "min_stay_arrival",
  "max_stay",
  "closed_to_arrival",
  "closed_to_departure",
  "stop_sell",
];

/** Availability lives on the room type, everything else on the rate plan. */
export function fieldBelongsToRatePlan(field: EditableField): boolean {
  return field !== "availability";
}
