import type { FrameGeometry, LayoutPlacementRow } from "./types";
import { fixtureByCode } from "./fixtures";

/**
 * DXF + PDF export helpers for layout deliverables.
 *
 * DXF is plain text — AC1009 (AutoCAD R12) is the most widely compatible
 * version. Coordinates are written directly in millimetres (the frame's
 * native units). Y axis stays up — DXF and the frame both use bottom-left
 * Cartesian, so no flipping is needed.
 *
 * Anyone with AutoCAD, LibreCAD, FreeCAD or DraftSight can open these files.
 */

// ── DXF emission ─────────────────────────────────────────────────────

const DXF_HEADER = `0
SECTION
2
HEADER
9
$ACADVER
1
AC1009
9
$INSUNITS
70
4
0
ENDSEC
0
SECTION
2
TABLES
0
TABLE
2
LAYER
70
4
0
LAYER
2
WALLS
70
0
62
7
6
CONTINUOUS
0
LAYER
2
ZONES
70
0
62
8
6
CONTINUOUS
0
LAYER
2
FIXTURES
70
0
62
3
6
CONTINUOUS
0
LAYER
2
OPENINGS
70
0
62
1
6
CONTINUOUS
0
ENDTAB
0
ENDSEC
0
SECTION
2
ENTITIES
`;

const DXF_FOOTER = `0
ENDSEC
0
EOF
`;

function dxfLine(x1: number, y1: number, x2: number, y2: number, layer: string): string {
  return `0
LINE
8
${layer}
10
${x1.toFixed(3)}
20
${y1.toFixed(3)}
30
0.0
11
${x2.toFixed(3)}
21
${y2.toFixed(3)}
31
0.0
`;
}

function dxfPolyline(points: [number, number][], layer: string, closed = true): string {
  let s = `0
LWPOLYLINE
8
${layer}
90
${points.length}
70
${closed ? 1 : 0}
`;
  for (const [x, y] of points) {
    s += `10
${x.toFixed(3)}
20
${y.toFixed(3)}
`;
  }
  return s;
}

function dxfText(x: number, y: number, value: string, height: number, layer: string): string {
  // Strip newlines / DXF-hostile chars from labels.
  const safe = String(value).replace(/[\r\n]/g, " ").slice(0, 80);
  return `0
TEXT
8
${layer}
10
${x.toFixed(3)}
20
${y.toFixed(3)}
30
0.0
40
${height.toFixed(3)}
1
${safe}
`;
}

/** Serialize a frame (+ optional placements) into a DXF document string. */
export function dxfFromLayout(
  frame: FrameGeometry,
  placements: LayoutPlacementRow[] = [],
): string {
  let body = "";

  // Walls
  for (const w of frame.walls) {
    body += dxfLine(w.x1, w.y1, w.x2, w.y2, "WALLS");
  }

  // Zones — closed polygons on the ZONES layer.
  for (const z of frame.zones) {
    if (z.polygon.length >= 3) body += dxfPolyline(z.polygon, "ZONES", true);
  }

  // Openings — draw the gap as a line on the OPENINGS layer.
  for (const op of frame.openings) {
    const wall = frame.walls.find((w) => w.id === op.wallId);
    if (!wall) continue;
    const t = op.position;
    const cx = wall.x1 + (wall.x2 - wall.x1) * t;
    const cy = wall.y1 + (wall.y2 - wall.y1) * t;
    const angle = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
    const half = op.width / 2;
    const x1 = cx - Math.cos(angle) * half;
    const y1 = cy - Math.sin(angle) * half;
    const x2 = cx + Math.cos(angle) * half;
    const y2 = cy + Math.sin(angle) * half;
    body += dxfLine(x1, y1, x2, y2, "OPENINGS");
  }

  // Fixtures — rotated rectangles + a label.
  for (const p of placements) {
    if (p.status === "rejected" && p.x === 0 && p.y === 0) continue;
    const def = fixtureByCode(p.fixture_code);
    const w = p.width / 2;
    const h = p.height / 2;
    const rad = (p.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const corners: [number, number][] = (
      [
        [-w, -h],
        [w, -h],
        [w, h],
        [-w, h],
      ] as [number, number][]
    ).map(([x, y]) => [p.x + x * cos - y * sin, p.y + x * sin + y * cos]);
    body += dxfPolyline(corners, "FIXTURES", true);
    body += dxfText(
      p.x,
      p.y,
      def?.name ?? p.fixture_code,
      Math.min(p.width, p.height) * 0.18,
      "FIXTURES",
    );
  }

  return DXF_HEADER + body + DXF_FOOTER;
}

/** Trigger a browser download of a DXF string. */
export function downloadDxf(content: string, baseFilename: string) {
  const blob = new Blob([content], { type: "application/dxf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = sanitize(baseFilename) + ".dxf";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── PDF export from a DOM ref ────────────────────────────────────────

/**
 * PDF export by rasterising the SVG directly via the browser Image API.
 *
 * We deliberately do NOT use html2canvas: it parses computed CSS styles to
 * paint the DOM onto a canvas, and as of Tailwind v4 those styles contain
 * `oklch(...)` colour functions that html2canvas can't parse — the export
 * dies on "Attempting to parse an unsupported color function oklch".
 *
 * The SVG we render uses explicit hex colours, so serialising the SVG and
 * drawing it via `Image.src = blob:...` sidesteps the whole CSS pipeline.
 * Bonus: rasterising the vector directly is also sharper than a DOM screenshot.
 */
export async function downloadPdfFromElement(
  el: HTMLElement,
  title: string,
  subtitle: string,
  baseFilename: string,
): Promise<void> {
  const svg = el.querySelector("svg") as SVGSVGElement | null;
  if (!svg) throw new Error("No SVG element found inside the export container.");

  // Clone + set explicit width/height so the rasterised image picks up the
  // right resolution (the original may rely on CSS for sizing).
  const bbox = svg.getBoundingClientRect();
  const scale = 2; // 2× supersample → crisp at 100% PDF zoom
  const svgClone = svg.cloneNode(true) as SVGSVGElement;
  svgClone.setAttribute("width", String(bbox.width));
  svgClone.setAttribute("height", String(bbox.height));
  svgClone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  const svgString = new XMLSerializer().serializeToString(svgClone);
  const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);

  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Browser failed to load the serialised SVG."));
      img.src = svgUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, bbox.width * scale);
    canvas.height = Math.max(1, bbox.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get canvas 2d context.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL("image/png");
    const { default: jsPDF } = await import("jspdf");
    const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    pdf.setFontSize(14);
    pdf.text(title, 12, 12);
    pdf.setFontSize(9);
    pdf.setTextColor(100);
    pdf.text(subtitle, 12, 18);
    const availH = pageH - 26;
    const availW = pageW - 24;
    const ratio = canvas.width / canvas.height;
    let w = availW;
    let h = availW / ratio;
    if (h > availH) {
      h = availH;
      w = availH * ratio;
    }
    pdf.addImage(dataUrl, "PNG", (pageW - w) / 2, 22, w, h);
    pdf.save(sanitize(baseFilename) + ".pdf");
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-z0-9._-]/gi, "_").replace(/_+/g, "_");
}
