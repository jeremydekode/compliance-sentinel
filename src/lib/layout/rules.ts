import type {
  FrameGeometry,
  Opening,
  Placement,
  StoreType,
  Wall,
  Zone,
} from "./types";
import {
  FIXTURES,
  STORE_RECIPES,
  SPACE_RATIOS,
  fixtureByCode,
  type FixtureRecipe,
} from "./fixtures";

/**
 * Deterministic fixture placement engine.
 *
 * No LLM — given a validated frame + store type, this function produces
 * a list of placements honoring fixture rules (wall-mount, clearance,
 * entrance proximity, zone assignment). The output is plausible, not
 * optimal: the user reviews and overrides via the placement-review UI.
 *
 * Coordinates are in **millimetres**, matching the frame.
 */

/** Axis-aligned rectangle in mm. Used internally for collision tests. */
interface Rect {
  x: number; // center X
  y: number; // center Y
  width: number;
  height: number;
  rotation: number; // degrees
}

// Brand-standard minimum clearance for walking aisles. 900mm is the typical
// retail accessibility minimum — every fixture footprint must keep ≥ this
// distance from walls, columns and other fixtures.
const AISLE_MIN = 900; // mm
const ENTRANCE_RADIUS = 3000; // cashier must sit within this distance of door

export function placeFixtures(
  frame: FrameGeometry,
  storeType: StoreType,
): Placement[] {
  const placements: Placement[] = [];
  const occupied: Rect[] = [];

  const recipe = STORE_RECIPES[storeType];
  if (!recipe) return [];

  const storefront = findZone(frame.zones, "storefront") ?? syntheticStorefront(frame, storeType);
  const backroom = findZone(frame.zones, "backroom") ?? syntheticBackroom(frame, storeType);
  const entrance = findEntrance(frame.openings, frame.walls);

  // Walk recipe in declared order: required first, optional last.
  const ordered = [...recipe].sort((a, b) => Number(b.required) - Number(a.required));

  for (const item of ordered) {
    const fixture = fixtureByCode(item.code);
    if (!fixture) continue;

    for (let i = 0; i < item.count; i++) {
      const targetZone = pickZoneFor(fixture, storefront, backroom);
      if (!targetZone) {
        placements.push(failedPlacement(item, fixture, "No matching zone in frame"));
        continue;
      }

      let placed: Rect | null = null;
      let reason = "";

      if (fixture.preferEntrance && entrance) {
        const result = tryNearPoint(entrance.point, fixture, targetZone, occupied);
        if (result) {
          placed = result;
          reason = `Placed within ${ENTRANCE_RADIUS / 1000} m of entrance, facing customer flow`;
        }
      }
      if (!placed && fixture.requiresWall) {
        const result = tryAlongPerimeter(frame.walls, fixture, targetZone, occupied, frame.openings);
        if (result) {
          placed = result.rect;
          reason = `Against perimeter wall (clearance ${fixture.wallClearance} mm)`;
        }
      }
      if (!placed) {
        const result = tryInZoneGrid(fixture, targetZone, occupied);
        if (result) {
          placed = result;
          reason = `Free-standing in ${targetZone.label} (grid layout, aisle ${AISLE_MIN} mm)`;
        }
      }

      if (!placed) {
        placements.push(
          failedPlacement(item, fixture, item.required
            ? "Required but no room — adjust frame or change store type"
            : "No room remaining — skipped (optional)"),
        );
        continue;
      }

      occupied.push(expandedFor(placed, fixture.spacing));
      placements.push({
        id: makeId(),
        fixtureCode: fixture.code,
        x: placed.x,
        y: placed.y,
        rotation: placed.rotation,
        width: fixture.width,
        height: fixture.height,
        zone: targetZone.label,
        reason,
        status: "pending",
      });
    }
  }

  return placements;
}

// ── Helpers ────────────────────────────────────────────────────────────

function findZone(zones: Zone[], label: Zone["label"]): Zone | null {
  return zones.find((z) => z.label === label) ?? null;
}

/**
 * When the sketch doesn't label storefront/backroom, partition the frame
 * along the long axis using the store type's space ratio.
 */
function syntheticStorefront(frame: FrameGeometry, storeType: StoreType): Zone | null {
  const { bbox } = frame;
  const ratio = SPACE_RATIOS[storeType].storefront;
  if (ratio === 0) return null;
  const longAxis = bbox.width >= bbox.height ? "x" : "y";
  if (longAxis === "x") {
    return {
      id: "synthetic_storefront",
      label: "storefront",
      polygon: rectPolygon(bbox.x, bbox.y, bbox.width * ratio, bbox.height),
    };
  }
  return {
    id: "synthetic_storefront",
    label: "storefront",
    polygon: rectPolygon(bbox.x, bbox.y, bbox.width, bbox.height * ratio),
  };
}

function syntheticBackroom(frame: FrameGeometry, storeType: StoreType): Zone | null {
  const { bbox } = frame;
  const ratio = SPACE_RATIOS[storeType].backroom;
  if (ratio === 0) return null;
  const longAxis = bbox.width >= bbox.height ? "x" : "y";
  if (longAxis === "x") {
    return {
      id: "synthetic_backroom",
      label: "backroom",
      polygon: rectPolygon(
        bbox.x + bbox.width * (1 - ratio),
        bbox.y,
        bbox.width * ratio,
        bbox.height,
      ),
    };
  }
  return {
    id: "synthetic_backroom",
    label: "backroom",
    polygon: rectPolygon(
      bbox.x,
      bbox.y + bbox.height * (1 - ratio),
      bbox.width,
      bbox.height * ratio,
    ),
  };
}

function rectPolygon(x: number, y: number, w: number, h: number): [number, number][] {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

function findEntrance(
  openings: Opening[],
  walls: Wall[],
): { point: { x: number; y: number }; wall: Wall } | null {
  const door = openings.find((o) => o.type === "door");
  if (!door) return null;
  const wall = walls.find((w) => w.id === door.wallId);
  if (!wall) return null;
  const t = door.position;
  return {
    point: { x: wall.x1 + (wall.x2 - wall.x1) * t, y: wall.y1 + (wall.y2 - wall.y1) * t },
    wall,
  };
}

function pickZoneFor(fixture: ReturnType<typeof fixtureByCode>, storefront: Zone | null, backroom: Zone | null): Zone | null {
  if (!fixture) return null;
  if (fixture.allowedZones.includes("backroom") && backroom) return backroom;
  if (fixture.allowedZones.includes("storefront") && storefront) return storefront;
  if (fixture.allowedZones.includes("service") && storefront) return storefront;
  if (fixture.allowedZones.includes("entrance") && storefront) return storefront;
  return storefront ?? backroom;
}

/**
 * Try to place a fixture as close to `point` as possible inside `zone`,
 * within ENTRANCE_RADIUS, without overlapping `occupied`.
 */
function tryNearPoint(
  point: { x: number; y: number },
  fixture: NonNullable<ReturnType<typeof fixtureByCode>>,
  zone: Zone,
  occupied: Rect[],
): Rect | null {
  const bbox = polygonBBox(zone.polygon);
  // Step a small grid outward from the entrance point until we find a fit.
  const step = 200;
  for (let r = 0; r <= ENTRANCE_RADIUS; r += step) {
    for (let theta = 0; theta < 360; theta += 30) {
      const rad = (theta * Math.PI) / 180;
      const cx = point.x + r * Math.cos(rad);
      const cy = point.y + r * Math.sin(rad);
      const rect: Rect = { x: cx, y: cy, width: fixture.width, height: fixture.height, rotation: 0 };
      if (!rectInsideBBox(rect, bbox)) continue;
      if (rectsOverlapAny(rect, occupied)) continue;
      return rect;
    }
  }
  return null;
}

/** Walk perimeter walls and find a free slot for a wall-requiring fixture. */
function tryAlongPerimeter(
  walls: Wall[],
  fixture: NonNullable<ReturnType<typeof fixtureByCode>>,
  zone: Zone,
  occupied: Rect[],
  openings: Opening[],
): { rect: Rect } | null {
  const bbox = polygonBBox(zone.polygon);
  const sorted = [...walls].sort((a, b) => wallLength(b) - wallLength(a));
  for (const wall of sorted) {
    const length = wallLength(wall);
    if (length < fixture.width + 600) continue;
    const angle = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
    // Step along the wall in `step` increments, skipping near openings.
    const step = 300;
    for (let s = 300; s + fixture.width <= length - 300; s += step) {
      const mid = s + fixture.width / 2;
      if (isNearOpening(wall.id, mid / length, openings)) continue;
      const t = mid / length;
      const cx = wall.x1 + (wall.x2 - wall.x1) * t;
      const cy = wall.y1 + (wall.y2 - wall.y1) * t;
      // Offset half the fixture depth inward (perpendicular to wall).
      const nx = -Math.sin(angle) * (fixture.height / 2);
      const ny = Math.cos(angle) * (fixture.height / 2);
      const rect: Rect = {
        x: cx + nx,
        y: cy + ny,
        width: fixture.width,
        height: fixture.height,
        rotation: (angle * 180) / Math.PI,
      };
      if (!rectInsideBBox(rect, bbox)) continue;
      if (rectsOverlapAny(rect, occupied)) continue;
      return { rect };
    }
  }
  return null;
}

/** Lay down a grid in the zone, drop a fixture in the first free cell. */
function tryInZoneGrid(
  fixture: NonNullable<ReturnType<typeof fixtureByCode>>,
  zone: Zone,
  occupied: Rect[],
): Rect | null {
  const bbox = polygonBBox(zone.polygon);
  const cellW = fixture.width + AISLE_MIN;
  const cellH = fixture.height + AISLE_MIN;
  const margin = Math.max(fixture.wallClearance, 600);
  for (let y = bbox.y + margin + fixture.height / 2; y + fixture.height / 2 + margin <= bbox.y + bbox.height; y += cellH) {
    for (let x = bbox.x + margin + fixture.width / 2; x + fixture.width / 2 + margin <= bbox.x + bbox.width; x += cellW) {
      const rect: Rect = { x, y, width: fixture.width, height: fixture.height, rotation: 0 };
      if (rectsOverlapAny(rect, occupied)) continue;
      return rect;
    }
  }
  return null;
}

function failedPlacement(
  item: FixtureRecipe,
  fixture: NonNullable<ReturnType<typeof fixtureByCode>>,
  reason: string,
): Placement {
  return {
    id: makeId(),
    fixtureCode: item.code,
    x: 0,
    y: 0,
    rotation: 0,
    width: fixture.width,
    height: fixture.height,
    reason: `⚠ ${reason}`,
    status: "rejected",
  };
}

function wallLength(w: Wall): number {
  return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
}

function isNearOpening(wallId: string, t: number, openings: Opening[]): boolean {
  for (const op of openings) {
    if (op.wallId !== wallId) continue;
    if (Math.abs(op.position - t) < 0.15) return true;
  }
  return false;
}

function polygonBBox(poly: [number, number][]): { x: number; y: number; width: number; height: number } {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

function rectInsideBBox(r: Rect, bbox: { x: number; y: number; width: number; height: number }): boolean {
  return (
    r.x - r.width / 2 >= bbox.x &&
    r.x + r.width / 2 <= bbox.x + bbox.width &&
    r.y - r.height / 2 >= bbox.y &&
    r.y + r.height / 2 <= bbox.y + bbox.height
  );
}

function rectsOverlapAny(r: Rect, others: Rect[]): boolean {
  return others.some((o) => rectsOverlap(r, o));
}

/** Axis-aligned overlap. Ignores rotation — good enough for V1. */
function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) * 2 < a.width + b.width &&
    Math.abs(a.y - b.y) * 2 < a.height + b.height
  );
}

function expandedFor(r: Rect, spacing: number): Rect {
  return { ...r, width: r.width + spacing, height: r.height + spacing };
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Re-export fixture metadata for downstream callers.
export { FIXTURES };
