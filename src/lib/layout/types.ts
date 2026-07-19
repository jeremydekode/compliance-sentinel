/**
 * Retail Layout Planner — type definitions shared across server/client.
 *
 * Geometry uses **millimetres** internally (1 m = 1000 mm) — the convention
 * for architectural drawings. The SVG renderer scales to pixels for display.
 */

export type LayoutStatus =
  | "uploaded"
  | "digitizing"
  | "pending_frame_approval"
  | "frame_approved"
  | "placing_fixtures"
  | "pending_placement_review"
  | "approved";

export type StoreType = "standard" | "small" | "kiosk" | "cafe";

/** A wall segment, given as two endpoints in mm. */
export interface Wall {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness?: number; // mm, defaults to 100 if absent
}

/** A door or window, anchored to a wall. */
export interface Opening {
  id: string;
  wallId: string;
  /** Distance along wall (0..1, where 0 is wall's first endpoint). */
  position: number;
  /** Opening width in mm. */
  width: number;
  type: "door" | "window";
  label?: string;
}

/** A logical area (storefront / backroom / service zone) as a polygon. */
export interface Zone {
  id: string;
  label: "storefront" | "backroom" | "service" | "entrance" | "other";
  /** Polygon vertices in mm, clockwise. */
  polygon: [number, number][];
}

/** A dimension callout from the original sketch. */
export interface DimensionCallout {
  id: string;
  value: number;
  unit: "mm" | "m";
  /** Two anchor points the dimension was measured between, in mm. */
  from: [number, number];
  to: [number, number];
  label?: string;
}

export interface FrameGeometry {
  /** Working unit for all coords. We always store mm. */
  units: "mm";
  /** Bounding box of the layout — used to size SVG viewport. */
  bbox: { x: number; y: number; width: number; height: number };
  walls: Wall[];
  openings: Opening[];
  zones: Zone[];
  dimensions: DimensionCallout[];
  /** Total floor area in m². Convenience field, computed from zones. */
  totalAreaSqm: number;
}

/** One placed fixture in the layout. */
export interface Placement {
  id: string;
  /** Catalog code, e.g. "gondola_double", "chiller_open". */
  fixtureCode: string;
  /** Center position in mm. */
  x: number;
  y: number;
  /** Rotation in degrees, 0 = fixture's natural orientation. */
  rotation: number;
  /** Footprint in mm. Stored so renderer doesn't have to look up catalog. */
  width: number;
  height: number;
  /** Which zone this fixture belongs to (for grouping in review UI). */
  zone?: Zone["label"];
  /** Why the rules engine placed it here — shown in review UI. */
  reason?: string;
  status: "pending" | "approved" | "rejected";
}

/** A fixture as defined in the catalog. */
export interface FixtureDef {
  code: string;
  name: string;
  category:
    | "shelving"
    | "refrigeration"
    | "counter"
    | "display"
    | "service"
    | "promo";
  /** Footprint in mm (natural orientation). */
  width: number;
  height: number;
  /** Where this fixture is allowed — empty array means anywhere. */
  allowedZones: Zone["label"][];
  /** Distance fixture must keep from any wall, in mm. 0 = can touch wall. */
  wallClearance: number;
  /** Distance from neighbours (used for aisle math), in mm. */
  spacing: number;
  /** Hex colour for the SVG renderer. */
  fillColor: string;
  strokeColor: string;
  /** True if fixture must sit against a wall (e.g. chillers). */
  requiresWall: boolean;
  /** True if fixture must be near the entrance (e.g. cashier). */
  preferEntrance?: boolean;
}

/** Layout job row, as it lives in Supabase. */
export interface LayoutJob {
  id: string;
  workspace_id: string;
  title: string;
  status: LayoutStatus;
  store_type: StoreType | null;
  sketch_file_id: string | null;
  sketch_mime_type: string | null;
  sketch_drive_url: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface LayoutFrameRow {
  id: string;
  job_id: string;
  geometry: FrameGeometry;
  ai_confidence: number | null;
  ai_reasoning: string | null;
  ai_input_tokens: number | null;
  ai_output_tokens: number | null;
  ai_thinking_tokens: number | null;
  approved_at: string | null;
  created_at: string;
}

export interface LayoutPlacementRow {
  id: string;
  job_id: string;
  fixture_code: string;
  x: number;
  y: number;
  rotation: number;
  width: number;
  height: number;
  zone: string | null;
  reason: string | null;
  status: Placement["status"];
  created_at: string;
}
