import type { FixtureDef, StoreType } from "./types";

/**
 * Fixture catalog. Dimensions in **millimetres**, based on common retail
 * industry standards (convenience store / petrol mart / cafe formats).
 *
 * Adjust freely — this is just seed data so the rules engine has something
 * to place. Future: move to a `layout_fixtures` table editable from Settings.
 */
export const FIXTURES: FixtureDef[] = [
  // ── Shelving ──────────────────────────────────────────────────────────
  {
    code: "gondola_double",
    name: "Gondola (double-sided)",
    category: "shelving",
    width: 1200,
    height: 900,
    allowedZones: ["storefront"],
    wallClearance: 1200, // needs aisle on both sides
    spacing: 1200,
    fillColor: "#fef3c7",
    strokeColor: "#92400e",
    requiresWall: false,
  },
  {
    code: "gondola_wall",
    name: "Gondola (wall-mounted)",
    category: "shelving",
    width: 1200,
    // 425mm depth per brand standard (wall gondolas in convenience retail).
    height: 425,
    allowedZones: ["storefront"],
    wallClearance: 0,
    spacing: 900, // matches AISLE_MIN
    fillColor: "#fef3c7",
    strokeColor: "#92400e",
    requiresWall: true,
  },
  {
    code: "end_cap",
    name: "End cap / promo display",
    category: "promo",
    width: 600,
    height: 900,
    allowedZones: ["storefront", "entrance"],
    wallClearance: 600,
    spacing: 600,
    fillColor: "#fed7aa",
    strokeColor: "#9a3412",
    requiresWall: false,
  },

  // ── Refrigeration ─────────────────────────────────────────────────────
  {
    code: "chiller_open",
    name: "Chiller (open-front)",
    category: "refrigeration",
    width: 1500,
    height: 800,
    allowedZones: ["storefront"],
    wallClearance: 0,
    spacing: 1200,
    fillColor: "#dbeafe",
    strokeColor: "#1e40af",
    requiresWall: true,
  },
  {
    code: "chiller_closed",
    name: "Chiller (glass-door)",
    category: "refrigeration",
    width: 1200,
    height: 800,
    allowedZones: ["storefront"],
    wallClearance: 0,
    spacing: 1200,
    fillColor: "#dbeafe",
    strokeColor: "#1e40af",
    requiresWall: true,
  },
  {
    code: "freezer_chest",
    name: "Chest freezer",
    category: "refrigeration",
    width: 1500,
    height: 700,
    allowedZones: ["storefront"],
    wallClearance: 600,
    spacing: 900,
    fillColor: "#cffafe",
    strokeColor: "#155e75",
    requiresWall: false,
  },

  // ── Counters ──────────────────────────────────────────────────────────
  {
    code: "cashier_counter",
    name: "Cashier counter",
    category: "counter",
    width: 1800,
    height: 600,
    allowedZones: ["storefront", "entrance"],
    wallClearance: 900, // staff needs to stand behind
    spacing: 600,
    fillColor: "#e9d5ff",
    strokeColor: "#6b21a8",
    requiresWall: false,
    preferEntrance: true,
  },
  {
    code: "counter_lshape",
    name: "L-shape service counter",
    category: "counter",
    width: 2400,
    height: 1800,
    allowedZones: ["storefront", "service"],
    wallClearance: 900,
    spacing: 600,
    fillColor: "#e9d5ff",
    strokeColor: "#6b21a8",
    requiresWall: true,
    preferEntrance: true,
  },
  {
    code: "prep_counter",
    name: "Prep counter (food)",
    category: "service",
    width: 1800,
    height: 700,
    allowedZones: ["backroom", "service"],
    wallClearance: 0,
    spacing: 900,
    fillColor: "#fce7f3",
    strokeColor: "#9d174d",
    requiresWall: true,
  },

  // ── Cafe-specific ─────────────────────────────────────────────────────
  {
    code: "coffee_machine",
    name: "Coffee machine bank",
    category: "service",
    width: 800,
    height: 600,
    allowedZones: ["service", "storefront"],
    wallClearance: 0,
    spacing: 300,
    fillColor: "#f5d0a9",
    strokeColor: "#7c2d12",
    requiresWall: true,
  },
  {
    code: "display_case",
    name: "Cold display case",
    category: "display",
    width: 1200,
    height: 500,
    allowedZones: ["storefront", "service"],
    wallClearance: 0,
    spacing: 600,
    fillColor: "#cffafe",
    strokeColor: "#155e75",
    requiresWall: false,
  },

  // ── Promo ─────────────────────────────────────────────────────────────
  {
    code: "dump_bin",
    name: "Dump bin",
    category: "promo",
    width: 800,
    height: 800,
    allowedZones: ["storefront", "entrance"],
    wallClearance: 800,
    spacing: 600,
    fillColor: "#fde68a",
    strokeColor: "#854d0e",
    requiresWall: false,
  },
];

export function fixtureByCode(code: string): FixtureDef | undefined {
  return FIXTURES.find((f) => f.code === code);
}

/**
 * Per-store-type recipe — what fixtures should appear, in priority order.
 * The rules engine walks this list, placing as many as fit.
 */
export interface FixtureRecipe {
  code: string;
  count: number;
  required: boolean;
}

export const STORE_RECIPES: Record<StoreType, FixtureRecipe[]> = {
  standard: [
    { code: "cashier_counter", count: 1, required: true },
    { code: "chiller_open", count: 2, required: true },
    { code: "chiller_closed", count: 1, required: false },
    { code: "gondola_wall", count: 4, required: true },
    { code: "gondola_double", count: 4, required: true },
    { code: "end_cap", count: 2, required: false },
    { code: "freezer_chest", count: 1, required: false },
    { code: "dump_bin", count: 1, required: false },
  ],
  small: [
    { code: "cashier_counter", count: 1, required: true },
    { code: "chiller_closed", count: 1, required: true },
    { code: "gondola_wall", count: 3, required: true },
    { code: "gondola_double", count: 2, required: true },
    { code: "end_cap", count: 1, required: false },
  ],
  kiosk: [
    { code: "counter_lshape", count: 1, required: true },
    { code: "chiller_closed", count: 1, required: true },
    { code: "display_case", count: 1, required: false },
  ],
  cafe: [
    { code: "counter_lshape", count: 1, required: true },
    { code: "coffee_machine", count: 1, required: true },
    { code: "display_case", count: 2, required: true },
    { code: "chiller_closed", count: 1, required: false },
    { code: "prep_counter", count: 1, required: true },
  ],
};

/**
 * Space allocation rules — storefront:backroom ratio.
 * Drives zone partitioning when sketch doesn't already label them.
 */
export const SPACE_RATIOS: Record<StoreType, { storefront: number; backroom: number }> = {
  // Standard convenience-retail split: 84% trading (storefront), 16% backroom.
  standard: { storefront: 0.84, backroom: 0.16 },
  small: { storefront: 0.85, backroom: 0.15 },
  kiosk: { storefront: 1.0, backroom: 0 },
  cafe: { storefront: 0.6, backroom: 0.4 },
};

export const STORE_TYPE_META: Record<StoreType, { name: string; description: string }> = {
  standard: {
    name: "Standard store",
    description: "Full-format convenience / petrol mart, 40-80 m²",
  },
  small: {
    name: "Small format",
    description: "Compact convenience store, 20-40 m²",
  },
  kiosk: {
    name: "Kiosk",
    description: "Counter-service kiosk, 5-15 m², no aisles",
  },
  cafe: {
    name: "Cafe / QSR",
    description: "Food service with seating, 30-60 m²",
  },
};
