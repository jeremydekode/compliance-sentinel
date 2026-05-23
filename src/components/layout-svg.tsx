import { useMemo } from "react";
import type {
  FrameGeometry,
  LayoutPlacementRow,
  Wall,
  Opening,
  DimensionCallout,
} from "@/lib/layout/types";
import { fixtureByCode } from "@/lib/layout/fixtures";

/**
 * Architectural-style SVG renderer for layout frames + placements.
 *
 * Conventions matched to professional CAD floor plans:
 * - Walls drawn as DOUBLE-LINE polygons with 45° diagonal hatching between
 *   (the "criss-cross" look that signals solid masonry / partition)
 * - Openings rendered as white gaps in the wall polygon
 * - Door swing arcs in thin dashed black line
 * - Dimensions in architectural style: extension lines + 45° tick marks +
 *   label above the dimension line (no big arrowheads)
 * - Fixtures: thin outline + subtle fill + label
 * - No colored zone fills — clean white background like a real CAD drawing
 *
 * Y-up coordinates internally; flipped to SVG Y-down via transform.
 * All measurements in millimetres.
 */
export function LayoutSvg({
  frame,
  placements = [],
  highlightPlacementId,
  onPlacementClick,
  className,
}: {
  frame: FrameGeometry;
  placements?: LayoutPlacementRow[];
  highlightPlacementId?: string | null;
  onPlacementClick?: (id: string) => void;
  className?: string;
}) {
  const { viewBox, walls, openings, dimensions, flipY, maxDim, hatchSize, hatchLineW, dimTick, fontSize, hatchId } = useMemo(() => {
    const maxD = Math.max(frame.bbox.width, frame.bbox.height);
    const margin = maxD * 0.15;
    const vb = `${frame.bbox.x - margin} ${frame.bbox.y - margin} ${
      frame.bbox.width + margin * 2
    } ${frame.bbox.height + margin * 2}`;
    return {
      viewBox: vb,
      walls: frame.walls,
      openings: frame.openings,
      dimensions: frame.dimensions,
      flipY: 2 * frame.bbox.y + frame.bbox.height,
      maxDim: maxD,
      // Hatch tuned so stripes are clearly visible at typical preview size.
      // Coarser spacing + thicker pattern lines = readable at 600-800px display.
      hatchSize: maxD * 0.04,
      hatchLineW: maxD * 0.005,
      dimTick: Math.max(80, maxD * 0.012),
      fontSize: Math.max(120, maxD * 0.022),
      // Unique per frame instance so two SVGs on the same page don't share IDs.
      hatchId: `wallHatch-${Math.round(frame.bbox.width)}-${Math.round(frame.bbox.height)}`,
    };
  }, [frame]);

  // Cap how thick walls render so an over-eager AI thickness value (the user
  // saw 800-1000mm walls) doesn't dominate the drawing. Architectural interior
  // partitions are 100-150mm; exterior up to 250mm.
  const MAX_WALL_THICKNESS = 200;

  const wallById = useMemo(() => {
    const m = new Map<string, Wall>();
    for (const w of walls) m.set(w.id, w);
    return m;
  }, [walls]);

  return (
    <svg
      viewBox={viewBox}
      className={className}
      style={{ width: "100%", height: "auto", background: "#ffffff" }}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        {/* Architectural diagonal hatch for solid walls. Single direction (45°). */}
        <pattern
          id={hatchId}
          patternUnits="userSpaceOnUse"
          width={hatchSize}
          height={hatchSize}
          patternTransform="rotate(45)"
        >
          <rect width={hatchSize} height={hatchSize} fill="#ffffff" />
          <line x1="0" y1="0" x2="0" y2={hatchSize} stroke="#334155" strokeWidth={hatchLineW} />
        </pattern>
      </defs>

      <g transform={`translate(0, ${flipY}) scale(1, -1)`}>
        {/* Walls — drawn as double-line polygons with hatched fill.
            Stroke width is in PIXELS (non-scaling) so edges stay crisp at
            any zoom without dominating the drawing. */}
        {walls.map((w) => {
          const corners = wallPolygon(w, MAX_WALL_THICKNESS);
          if (!corners) return null;
          return (
            <polygon
              key={w.id}
              points={corners.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ")}
              fill={`url(#${hatchId})`}
              stroke="#1f2937"
              strokeWidth={1.5}
              strokeLinejoin="miter"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}

        {/* Openings — cut a white gap out of the wall + draw door/window detail. */}
        {openings.map((op) => {
          const wall = wallById.get(op.wallId);
          if (!wall) return null;
          const gap = openingPolygon(wall, op, MAX_WALL_THICKNESS);
          if (!gap) return null;

          // Endpoints of the opening along the wall centreline (for door swing geometry).
          const dx = wall.x2 - wall.x1;
          const dy = wall.y2 - wall.y1;
          const len = Math.hypot(dx, dy);
          const t = op.position;
          const cx = wall.x1 + dx * t;
          const cy = wall.y1 + dy * t;
          const ux = dx / len;
          const uy = dy / len;
          const nx = -uy;
          const ny = ux;
          const half = op.width / 2;
          const e1x = cx - ux * half;
          const e1y = cy - uy * half;
          const e2x = cx + ux * half;
          const e2y = cy + uy * half;

          return (
            <g key={op.id}>
              {/* White polygon cuts the hatched wall — appears as a clean gap. */}
              <polygon
                points={gap.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ")}
                fill="#ffffff"
                stroke="#1f2937"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              {op.type === "door" && (
                <>
                  {/* Door leaf */}
                  <line
                    x1={e1x}
                    y1={e1y}
                    x2={e1x + nx * op.width}
                    y2={e1y + ny * op.width}
                    stroke="#1f2937"
                    strokeWidth={1.2}
                    vectorEffect="non-scaling-stroke"
                  />
                  {/* Swing arc — thin dashed */}
                  <path
                    d={`M ${e2x} ${e2y} A ${op.width} ${op.width} 0 0 0 ${e1x + nx * op.width} ${e1y + ny * op.width}`}
                    fill="none"
                    stroke="#1f2937"
                    strokeWidth={0.8}
                    strokeDasharray="4 4"
                    vectorEffect="non-scaling-stroke"
                  />
                </>
              )}
              {op.type === "window" && (
                <line
                  x1={e1x}
                  y1={e1y}
                  x2={e2x}
                  y2={e2y}
                  stroke="#1f2937"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </g>
          );
        })}

        {/* Fixtures — thin outline + subtle category-coloured fill + label. */}
        {placements.map((p) => {
          const def = fixtureByCode(p.fixture_code);
          const highlighted = highlightPlacementId === p.id;
          if (p.status === "rejected" && p.x === 0 && p.y === 0) return null;
          return (
            <g
              key={p.id}
              transform={`translate(${p.x}, ${p.y}) rotate(${p.rotation})`}
              onClick={() => onPlacementClick?.(p.id)}
              style={{ cursor: onPlacementClick ? "pointer" : "default" }}
              opacity={p.status === "rejected" ? 0.3 : 1}
            >
              <rect
                x={-p.width / 2}
                y={-p.height / 2}
                width={p.width}
                height={p.height}
                fill={def?.fillColor ?? "#f8fafc"}
                fillOpacity={0.5}
                stroke={highlighted ? "#0ea5e9" : "#1f2937"}
                strokeWidth={highlighted ? 2.5 : 1}
                vectorEffect="non-scaling-stroke"
              />
              <g transform="scale(1, -1)">
                <text
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={Math.min(p.width, p.height) * 0.16}
                  fill="#1f2937"
                  fontFamily="sans-serif"
                  style={{ pointerEvents: "none" }}
                >
                  {def?.name ?? p.fixture_code}
                </text>
              </g>
            </g>
          );
        })}

        {/* Dimensions — architectural style with tick marks + extension lines. */}
        {dimensions.map((d) => (
          <ArchDimension
            key={d.id}
            d={d}
            tickLen={dimTick}
            fontSize={fontSize * 0.85}
          />
        ))}
      </g>
    </svg>
  );
}

// ── Dimension component ──────────────────────────────────────────────

/** Architectural dimension: extension lines + tick marks + label. */
function ArchDimension({
  d,
  tickLen,
  fontSize,
}: {
  d: DimensionCallout;
  tickLen: number;
  fontSize: number;
}) {
  const [x1, y1] = d.from;
  const [x2, y2] = d.to;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const angle = Math.atan2(dy, dx);
  // 45° tick mark direction (perpendicular-ish, but rotated 45° from dim line).
  const tickDx = Math.cos(angle + Math.PI / 4) * (tickLen / 2);
  const tickDy = Math.sin(angle + Math.PI / 4) * (tickLen / 2);
  // Perpendicular offset for the label (above the dimension line).
  const perpX = -Math.sin(angle);
  const perpY = Math.cos(angle);
  const labelOffset = tickLen * 0.9;
  const mx = (x1 + x2) / 2 + perpX * labelOffset;
  const my = (y1 + y2) / 2 + perpY * labelOffset;
  const labelText = d.label ?? formatDim(d.value, d.unit);

  return (
    <g>
      {/* Main dimension line */}
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#475569" strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
      {/* Tick marks at both endpoints (45° diagonal strokes) */}
      <line
        x1={x1 - tickDx}
        y1={y1 - tickDy}
        x2={x1 + tickDx}
        y2={y1 + tickDy}
        stroke="#475569"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      <line
        x1={x2 - tickDx}
        y1={y2 - tickDy}
        x2={x2 + tickDx}
        y2={y2 + tickDy}
        stroke="#475569"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      {/* Label — flip back to readable orientation */}
      <g transform={`translate(${mx}, ${my}) scale(1, -1)`}>
        <text
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={fontSize}
          fill="#1f2937"
          fontFamily="sans-serif"
        >
          {labelText}
        </text>
      </g>
    </g>
  );
}

// ── Geometry helpers ─────────────────────────────────────────────────

/** Compute the 4 corners of a wall as a thick polygon (for hatched fill). */
function wallPolygon(w: Wall, maxThickness: number): [number, number][] | null {
  const dx = w.x2 - w.x1;
  const dy = w.y2 - w.y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const rawT = w.thickness ?? 100;
  const t = Math.min(rawT, maxThickness) / 2;
  const nx = (-dy / len) * t;
  const ny = (dx / len) * t;
  return [
    [w.x1 + nx, w.y1 + ny],
    [w.x2 + nx, w.y2 + ny],
    [w.x2 - nx, w.y2 - ny],
    [w.x1 - nx, w.y1 - ny],
  ];
}

/** Compute the 4 corners of an opening's footprint inside a wall. */
function openingPolygon(w: Wall, op: Opening, maxThickness: number): [number, number][] | null {
  const dx = w.x2 - w.x1;
  const dy = w.y2 - w.y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const rawT = w.thickness ?? 100;
  const t = Math.min(rawT, maxThickness) / 2;
  const nx = (-dy / len) * t;
  const ny = (dx / len) * t;
  const ux = dx / len;
  const uy = dy / len;
  const cx = w.x1 + dx * op.position;
  const cy = w.y1 + dy * op.position;
  const half = op.width / 2;
  return [
    [cx - ux * half + nx, cy - uy * half + ny],
    [cx + ux * half + nx, cy + uy * half + ny],
    [cx + ux * half - nx, cy - uy * half - ny],
    [cx - ux * half - nx, cy - uy * half - ny],
  ];
}

/** Format a dimension value into a clean architectural label. */
function formatDim(value: number, unit: "mm" | "m"): string {
  if (unit === "m") return `${value.toFixed(2)} m`;
  // mm: omit decimals if whole, otherwise 1dp
  if (Number.isInteger(value)) return `${value}`;
  return value.toFixed(0);
}
