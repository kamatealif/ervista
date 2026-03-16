"use client";

import dynamic from "next/dynamic";
import { useMemo, useState, useRef } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

type DiagramAttribute = {
  name: string;
  type: string;
  isPrimary: boolean;
  isForeign: boolean;
  references?: string;
};

type DiagramEntity = {
  name: string;
  attributes: DiagramAttribute[];
};

type DiagramModel = {
  entities: DiagramEntity[];
};

// ─── SQL Parser ───────────────────────────────────────────────────────────────

function stripIdentifierQuotes(value: string): string {
  const t = value.trim();
  if (!t) return t;
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("`") && t.endsWith("`")) ||
    (t.startsWith("'") && t.endsWith("'"))
  )
    return t.slice(1, -1).trim();
  if (t.startsWith("[") && t.endsWith("]")) return t.slice(1, -1).trim();
  return t;
}

function normalizeIdentifier(raw: string): string {
  return raw
    .split(".")
    .map((p) => stripIdentifierQuotes(p))
    .filter(Boolean)
    .join(".");
}

function getShortName(tableName: string): string {
  const parts = tableName.split(".");
  return parts[parts.length - 1] ?? tableName;
}

function removeSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--.*$/gm, " ");
}

function splitTopLevelComma(input: string): string[] {
  const chunks: string[] = [];
  let start = 0,
    depth = 0;
  let quote: "'" | '"' | "`" | "]" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (quote === "]") {
        if (ch === "]") quote = null;
        continue;
      }
      if (ch === quote) {
        if (quote === "'" && input[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "[") {
      quote = "]";
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === "," && depth === 0) {
      const s = input.slice(start, i).trim();
      if (s) chunks.push(s);
      start = i + 1;
    }
  }
  const trail = input.slice(start).trim();
  if (trail) chunks.push(trail);
  return chunks;
}

function extractCreateTableBlocks(
  sql: string,
): Array<{ tableName: string; body: string }> {
  const cleaned = removeSqlComments(sql);
  const blocks: Array<{ tableName: string; body: string }> = [];
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    let cursor = re.lastIndex;
    while (cursor < cleaned.length && /\s/.test(cleaned[cursor] ?? ""))
      cursor++;
    const nameStart = cursor;
    while (cursor < cleaned.length && cleaned[cursor] !== "(") cursor++;
    if (cursor >= cleaned.length) break;
    const rawName = cleaned.slice(nameStart, cursor).trim();
    const bodyStart = cursor + 1;
    let depth = 0,
      closeIdx = -1;
    let q: "'" | '"' | "`" | "]" | null = null;
    for (cursor = bodyStart; cursor < cleaned.length; cursor++) {
      const ch = cleaned[cursor];
      if (q) {
        if (q === "]") {
          if (ch === "]") q = null;
          continue;
        }
        if (ch === q) {
          if (q === "'" && cleaned[cursor + 1] === "'") cursor++;
          else q = null;
        }
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        q = ch;
        continue;
      }
      if (ch === "[") {
        q = "]";
        continue;
      }
      if (ch === "(") {
        depth++;
        continue;
      }
      if (ch === ")") {
        if (depth === 0) {
          closeIdx = cursor;
          break;
        }
        depth--;
      }
    }
    if (closeIdx === -1) break;
    blocks.push({
      tableName: normalizeIdentifier(rawName),
      body: cleaned.slice(bodyStart, closeIdx),
    });
    re.lastIndex = closeIdx + 1;
  }
  return blocks;
}

function parseSqlSchema(sql: string): DiagramModel {
  const blocks = extractCreateTableBlocks(sql);
  if (!blocks.length) return { entities: [] };
  const entities: DiagramEntity[] = [];
  for (const block of blocks) {
    const sections = splitTopLevelComma(block.body);
    const attributes: DiagramAttribute[] = [];
    const pkCols = new Set<string>();
    const fkCols = new Set<string>();
    const fkRefs: Record<string, string> = {};

    for (let rawSec of sections) {
      let section = rawSec.trim();
      if (!section) continue;
      if (/^constraint\b/i.test(section))
        section = section.replace(
          /^constraint\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[^\s]+)\s+/i,
          "",
        );

      const pkMatch = section.match(/^primary\s+key\s*\(([^)]+)\)/i);
      if (pkMatch) {
        splitTopLevelComma(pkMatch[1])
          .map((c) => normalizeIdentifier(c))
          .forEach((c) => pkCols.add(c.toLowerCase()));
        continue;
      }
      const fkMatch = section.match(
        /^foreign\s+key\s*\(([^)]+)\)\s*references\s+([^\s(]+)\s*\(([^)]+)\)/i,
      );
      if (fkMatch) {
        const ref = normalizeIdentifier(fkMatch[2]);
        splitTopLevelComma(fkMatch[1])
          .map((c) => normalizeIdentifier(c))
          .forEach((c) => {
            const k = c.toLowerCase();
            fkCols.add(k);
            fkRefs[k] = ref;
          });
        continue;
      }
      const colMatch = section.match(
        /^("([^"]+)"|`([^`]+)`|\[[^\]]+\]|[^\s]+)\s+([\s\S]+)$/i,
      );
      if (!colMatch) continue;
      const colName = normalizeIdentifier(colMatch[1]);
      const definition = colMatch[4].trim();
      const kIdx = definition.search(
        /\s+(?:not\s+null|null|primary\s+key|references|unique|check|default|constraint|generated|collate|identity|auto_increment)\b/i,
      );
      const type = (
        kIdx === -1 ? definition : definition.slice(0, kIdx)
      ).trim();
      const extras = kIdx === -1 ? "" : definition.slice(kIdx).trim();
      const isPrimary = /\bprimary\s+key\b/i.test(extras);
      const isForeign = /\breferences\b/i.test(extras);
      let references: string | undefined;
      const refMatch = extras.match(/references\s+([^\s(]+)/i);
      if (refMatch) references = normalizeIdentifier(refMatch[1]);
      attributes.push({
        name: colName,
        type,
        isPrimary,
        isForeign,
        references,
      });
    }

    entities.push({
      name: block.tableName,
      attributes: attributes.map((attr) => {
        const k = attr.name.toLowerCase();
        return {
          ...attr,
          isPrimary: attr.isPrimary || pkCols.has(k),
          isForeign: attr.isForeign || fkCols.has(k),
          references: attr.references || fkRefs[k],
        };
      }),
    });
  }
  return { entities };
}

// ─── Layout (with random seed) ────────────────────────────────────────────────

type Point = { x: number; y: number };

type LayoutAttribute = {
  id: string;
  x: number;
  y: number;
  rx: number;
  ry: number;
  label: string;
  lineStart: Point;
  lineEnd: Point;
  isPrimary: boolean;
  isForeign: boolean;
  references?: string;
};

type LayoutEntity = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
  attributes: LayoutAttribute[];
};

type DiagramLayout = {
  width: number;
  height: number;
  entities: LayoutEntity[];
};

// Simple seeded PRNG (mulberry32)
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rectEdgePoint(entity: LayoutEntity, target: Point): Point {
  const dx = target.x - entity.cx,
    dy = target.y - entity.cy;
  if (Math.abs(dx) * entity.height >= Math.abs(dy) * entity.width)
    return {
      x: entity.x + (dx >= 0 ? entity.width : 0),
      y: entity.cy + (dy * (entity.width / 2)) / Math.max(1, Math.abs(dx)),
    };
  return {
    x: entity.cx + (dx * (entity.height / 2)) / Math.max(1, Math.abs(dy)),
    y: entity.y + (dy >= 0 ? entity.height : 0),
  };
}

function ellipseEdgePoint(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  target: Point,
): Point {
  const dx = target.x - cx,
    dy = target.y - cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len,
    uy = dy / len;
  const scale = 1 / Math.sqrt((ux * ux) / (rx * rx) + (uy * uy) / (ry * ry));
  return { x: cx + ux * scale, y: cy + uy * scale };
}

function buildLayout(model: DiagramModel, seed: number): DiagramLayout {
  if (!model.entities.length) return { width: 1600, height: 900, entities: [] };

  const rng = makeRng(seed);

  const ENT_W = 200,
    ENT_H = 70;
  const ATT_RX = 72,
    ATT_RY = 26;
  const ORBIT_R = 165;
  const PAD = 300;
  const CELL_W = (ORBIT_R + ATT_RX) * 2 + 140;
  const CELL_H = (ORBIT_R + ATT_RY) * 2 + 140;

  const n = model.entities.length;
  // Randomize column count slightly: prefer sqrt but jitter by ±1
  const baseCols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const cols = Math.max(1, baseCols + (rng() > 0.5 && baseCols > 1 ? -1 : 0));
  const rows = Math.ceil(n / cols);

  const canvasW = Math.max(1600, cols * CELL_W + PAD * 2);
  const canvasH = Math.max(900, rows * CELL_H + PAD * 2);

  // Build shuffled entity order per seed
  const indices = Array.from({ length: n }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j]!, indices[i]!];
  }

  const entities: LayoutEntity[] = model.entities.map((ent, originalIdx) => {
    // find this entity's slot in the shuffled grid
    const slotIdx = indices.indexOf(originalIdx);
    const col = slotIdx % cols;
    const row = Math.floor(slotIdx / cols);

    // Add a small random jitter to each entity center so it doesn't look grid-locked
    const jitterX = (rng() - 0.5) * 60;
    const jitterY = (rng() - 0.5) * 60;

    const cx = PAD + col * CELL_W + CELL_W / 2 + jitterX;
    const cy = PAD + row * CELL_H + CELL_H / 2 + jitterY;

    const entity: LayoutEntity = {
      id: `ent-${ent.name.toLowerCase().replace(/\W+/g, "_")}`,
      name: getShortName(ent.name),
      x: cx - ENT_W / 2,
      y: cy - ENT_H / 2,
      width: ENT_W,
      height: ENT_H,
      cx,
      cy,
      attributes: [],
    };

    const count = ent.attributes.length;
    // Randomize the starting angle so attributes fan out differently each time
    const startAngle = rng() * Math.PI * 2;

    ent.attributes.forEach((attr, j) => {
      const angle =
        count === 1 ? -Math.PI / 2 : startAngle + (2 * Math.PI * j) / count;
      const ax = cx + (ORBIT_R + ATT_RX * 0.4) * Math.cos(angle);
      const ay = cy + (ORBIT_R + ATT_RY * 0.4) * Math.sin(angle);
      const lineStart = rectEdgePoint(entity, { x: ax, y: ay });
      const lineEnd = ellipseEdgePoint(ax, ay, ATT_RX, ATT_RY, lineStart);
      entity.attributes.push({
        id: `${entity.id}-attr-${attr.name.toLowerCase().replace(/\W+/g, "_")}`,
        x: ax,
        y: ay,
        rx: ATT_RX,
        ry: ATT_RY,
        label:
          attr.name +
          (attr.isPrimary ? " (PK)" : attr.isForeign ? " (FK)" : ""),
        lineStart,
        lineEnd,
        isPrimary: attr.isPrimary,
        isForeign: attr.isForeign,
        references: attr.references,
      });
    });

    return entity;
  });

  return { width: canvasW, height: canvasH, entities };
}

// ─── Excalidraw Element Builder ───────────────────────────────────────────────

type ExElement = Record<string, unknown>;
let _eid = 1;
const eid = () => `el-${_eid++}-${Math.random().toString(36).slice(2)}`;
const BASE = {
  angle: 0,
  opacity: 100,
  isDeleted: false,
  frameId: null,
  link: null,
  locked: false,
  groupIds: [],
  version: 1,
  versionNonce: 1,
};

const makeRect = (
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Record<string, unknown> = {},
): ExElement => ({
  ...BASE,
  id: eid(),
  type: "rectangle",
  x,
  y,
  width: w,
  height: h,
  strokeColor: "#1e293b",
  backgroundColor: "#dbeafe",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 0,
  roundness: { type: 3, value: 6 },
  seed: Math.floor(Math.random() * 999999),
  ...extra,
});

const makeEllipse = (
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Record<string, unknown> = {},
): ExElement => ({
  ...BASE,
  id: eid(),
  type: "ellipse",
  x,
  y,
  width: w,
  height: h,
  strokeColor: "#334155",
  backgroundColor: "#f0fdf4",
  fillStyle: "solid",
  strokeWidth: 1.5,
  strokeStyle: "solid",
  roughness: 0,
  roundness: { type: 2 },
  seed: Math.floor(Math.random() * 999999),
  ...extra,
});

const makeDiamond = (
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Record<string, unknown> = {},
): ExElement => ({
  ...BASE,
  id: eid(),
  type: "diamond",
  x,
  y,
  width: w,
  height: h,
  strokeColor: "#78350f",
  backgroundColor: "#fef9c3",
  fillStyle: "solid",
  strokeWidth: 1.5,
  strokeStyle: "solid",
  roughness: 0,
  roundness: null,
  seed: Math.floor(Math.random() * 999999),
  ...extra,
});

const makeText = (
  x: number,
  y: number,
  text: string,
  fontSize = 14,
  bold = false,
  extra: Record<string, unknown> = {},
): ExElement => {
  const w = text.length * fontSize * 0.6 + 16,
    h = fontSize * 1.4;
  return {
    ...BASE,
    id: eid(),
    type: "text",
    x: x - w / 2,
    y: y - h / 2,
    width: w,
    height: h,
    strokeColor: "#0f172a",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    roundness: null,
    seed: Math.floor(Math.random() * 999999),
    text,
    fontSize,
    fontFamily: 3,
    textAlign: "center",
    verticalAlign: "middle",
    baseline: Math.floor(fontSize * 0.9),
    containerId: null,
    originalText: text,
    lineHeight: 1.25,
    autoResize: true,
    fontStyle: bold ? "bold" : "normal",
    ...extra,
  };
};

// Simple 2-point line (used for entity→attribute spokes)
const makeLine = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  extra: Record<string, unknown> = {},
): ExElement => ({
  ...BASE,
  id: eid(),
  type: "line",
  x: x1,
  y: y1,
  width: Math.abs(x2 - x1),
  height: Math.abs(y2 - y1),
  strokeColor: "#64748b",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 1.5,
  strokeStyle: "solid",
  roughness: 0,
  roundness: null,
  seed: Math.floor(Math.random() * 999999),
  points: [
    [0, 0],
    [x2 - x1, y2 - y1],
  ],
  lastCommittedPoint: null,
  startBinding: null,
  endBinding: null,
  startArrowhead: null,
  endArrowhead: null,
  ...extra,
});

// Multi-segment polyline — takes ABSOLUTE points, converts to relative
const makePolyline = (
  absPoints: Point[],
  extra: Record<string, unknown> = {},
): ExElement => {
  const origin = absPoints[0]!;
  const rel = absPoints.map((p) => [
    +(p.x - origin.x).toFixed(2),
    +(p.y - origin.y).toFixed(2),
  ]);
  const xs = absPoints.map((p) => p.x),
    ys = absPoints.map((p) => p.y);
  return {
    ...BASE,
    id: eid(),
    type: "line",
    x: origin.x,
    y: origin.y,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    strokeColor: "#64748b",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1.5,
    strokeStyle: "solid",
    roughness: 0,
    roundness: { type: 2 },
    seed: Math.floor(Math.random() * 999999),
    points: rel,
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
    ...extra,
  };
};

// ── Obstacle-aware orthogonal router ─────────────────────────────────────────

type Rect = { x: number; y: number; w: number; h: number };

function segHitsRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: Rect,
): boolean {
  const minX = Math.min(ax, bx),
    maxX = Math.max(ax, bx);
  const minY = Math.min(ay, by),
    maxY = Math.max(ay, by);
  if (maxX < r.x || minX > r.x + r.w || maxY < r.y || minY > r.y + r.h)
    return false;
  if (Math.abs(ax - bx) < 0.5)
    return ax >= r.x && ax <= r.x + r.w && maxY >= r.y && minY <= r.y + r.h;
  if (Math.abs(ay - by) < 0.5)
    return ay >= r.y && ay <= r.y + r.h && maxX >= r.x && minX <= r.x + r.w;
  return true;
}

function countHits(pts: Point[], obs: Rect[]): number {
  let hits = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!,
      b = pts[i + 1]!;
    for (const r of obs)
      if (segHitsRect(a.x, a.y, b.x, b.y, r)) {
        hits++;
        break;
      }
  }
  return hits;
}

function pathLen(pts: Point[]): number {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++)
    len += Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
  return len;
}

function simplify(pts: Point[]): Point[] {
  if (pts.length <= 2) return pts;
  const out: Point[] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = out[out.length - 1]!,
      c = pts[i]!,
      n = pts[i + 1]!;
    const collinear =
      (Math.abs(p.x - c.x) < 0.5 && Math.abs(c.x - n.x) < 0.5) ||
      (Math.abs(p.y - c.y) < 0.5 && Math.abs(c.y - n.y) < 0.5);
    if (!collinear) out.push(c);
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

function routeAvoiding(start: Point, end: Point, obs: Rect[]): Point[] {
  const CLEAR = 24;
  const inflated = obs.map((r) => ({
    x: r.x - CLEAR,
    y: r.y - CLEAR,
    w: r.w + CLEAR * 2,
    h: r.h + CLEAR * 2,
  }));

  if (countHits([start, end], inflated) === 0) return [start, end];

  const xCoords = new Set<number>([start.x, end.x, (start.x + end.x) / 2]);
  const yCoords = new Set<number>([start.y, end.y, (start.y + end.y) / 2]);
  for (const r of inflated) {
    xCoords.add(r.x - CLEAR);
    xCoords.add(r.x + r.w + CLEAR);
    yCoords.add(r.y - CLEAR);
    yCoords.add(r.y + r.h + CLEAR);
  }

  const candidates: Point[][] = [];
  for (const x of xCoords)
    candidates.push([start, { x, y: start.y }, { x, y: end.y }, end]);
  for (const y of yCoords)
    candidates.push([start, { x: start.x, y }, { x: end.x, y }, end]);
  for (const x of xCoords) {
    for (const y of yCoords) {
      candidates.push([
        start,
        { x, y: start.y },
        { x, y },
        { x: end.x, y },
        end,
      ]);
      candidates.push([
        start,
        { x: start.x, y },
        { x, y },
        { x, y: end.y },
        end,
      ]);
    }
  }

  let best: Point[] = [start, end];
  let bestHits = Infinity,
    bestLen = Infinity;
  for (const c of candidates) {
    const s = simplify(c);
    const h = countHits(s, inflated);
    const l = pathLen(s);
    if (h < bestHits || (h === bestHits && l < bestLen)) {
      best = s;
      bestHits = h;
      bestLen = l;
    }
  }
  return simplify(best);
}

function buildElements(layout: DiagramLayout): ExElement[] {
  const el: ExElement[] = [];

  const allAttrObs: Rect[] = layout.entities.flatMap((ent) =>
    ent.attributes.map((a) => ({
      x: a.x - a.rx,
      y: a.y - a.ry,
      w: a.rx * 2,
      h: a.ry * 2,
    })),
  );
  const allEntityObs: Rect[] = layout.entities.map((ent) => ({
    x: ent.x,
    y: ent.y,
    w: ent.width,
    h: ent.height,
  }));

  // ── Entities + attributes ──────────────────────────────────────────
  for (const ent of layout.entities) {
    el.push(
      makeRect(ent.x, ent.y, ent.width, ent.height, {
        strokeColor: "#1e40af",
        backgroundColor: "#bfdbfe",
        strokeWidth: 2,
      }),
    );
    el.push(
      makeText(ent.cx, ent.cy, ent.name, 16, true, { strokeColor: "#1e3a8a" }),
    );

    for (const attr of ent.attributes) {
      el.push(
        makeLine(
          attr.lineStart.x,
          attr.lineStart.y,
          attr.lineEnd.x,
          attr.lineEnd.y,
          {
            strokeColor: "#94a3b8",
          },
        ),
      );

      const bg = attr.isPrimary
        ? "#fef3c7"
        : attr.isForeign
          ? "#dcfce7"
          : "#ffffff";
      const sc = attr.isPrimary
        ? "#92400e"
        : attr.isForeign
          ? "#14532d"
          : "#475569";

      el.push(
        makeEllipse(
          attr.x - attr.rx,
          attr.y - attr.ry,
          attr.rx * 2,
          attr.ry * 2,
          {
            backgroundColor: bg,
            strokeColor: sc,
            strokeWidth: attr.isPrimary ? 2 : 1.5,
          },
        ),
      );

      if (attr.isPrimary) {
        const ins = 4;
        el.push(
          makeEllipse(
            attr.x - attr.rx + ins,
            attr.y - attr.ry + ins,
            (attr.rx - ins) * 2,
            (attr.ry - ins) * 2,
            {
              backgroundColor: "transparent",
              strokeColor: "#92400e",
              strokeWidth: 1,
            },
          ),
        );
      }

      el.push(
        makeText(attr.x, attr.y, attr.label, 12, attr.isPrimary, {
          strokeColor: attr.isPrimary
            ? "#78350f"
            : attr.isForeign
              ? "#14532d"
              : "#334155",
        }),
      );
    }
  }

  // ── Relationships ──────────────────────────────────────────────────
  for (const ent of layout.entities) {
    for (const attr of ent.attributes) {
      if (!attr.isForeign || !attr.references) continue;
      const tgt = layout.entities.find(
        (e) =>
          getShortName(e.name).toLowerCase() ===
          getShortName(attr.references!).toLowerCase(),
      );
      if (!tgt) continue;

      const mx = (ent.cx + tgt.cx) / 2;
      const my = (ent.cy + tgt.cy) / 2;
      const DW = 110,
        DH = 54;

      el.push(makeDiamond(mx - DW / 2, my - DH / 2, DW, DH));
      el.push(makeText(mx, my, "has", 12, false, { strokeColor: "#78350f" }));

      const dEdge = (tx: number, ty: number): Point => {
        const ddx = tx - mx,
          ddy = ty - my;
        const hw = DW / 2,
          hh = DH / 2;
        if (Math.abs(ddx) * hh > Math.abs(ddy) * hw) {
          const t = hw / Math.abs(ddx);
          return { x: mx + ddx * t, y: my + ddy * t };
        }
        const t = hh / Math.max(Math.abs(ddy), 0.001);
        return { x: mx + ddx * t, y: my + ddy * t };
      };

      const routeObs = [
        ...allAttrObs,
        ...allEntityObs.filter(
          (r) =>
            !(r.x === ent.x && r.y === ent.y) &&
            !(r.x === tgt.x && r.y === tgt.y),
        ),
      ];

      // Source → diamond
      const src = rectEdgePoint(ent, { x: mx, y: my });
      const dEntry = dEdge(src.x, src.y);
      const srcPath = routeAvoiding(src, dEntry, routeObs);
      el.push(makePolyline(srcPath, { strokeColor: "#64748b" }));
      const srcMid = srcPath[Math.floor(srcPath.length / 2)]!;
      el.push(
        makeText(srcMid.x + 10, srcMid.y - 14, "1", 12, true, {
          strokeColor: "#475569",
        }),
      );

      // Diamond → target
      const tgtPt = rectEdgePoint(tgt, { x: mx, y: my });
      const dExit = dEdge(tgtPt.x, tgtPt.y);
      const tgtPath = routeAvoiding(dExit, tgtPt, routeObs);
      el.push(
        makePolyline(tgtPath, {
          strokeColor: "#64748b",
          endArrowhead: "arrow",
        }),
      );
      const tgtMid = tgtPath[Math.floor(tgtPath.length / 2)]!;
      el.push(
        makeText(tgtMid.x + 10, tgtMid.y - 14, "N", 12, true, {
          strokeColor: "#475569",
        }),
      );
    }
  }

  return el;
}

// ─── Sample SQL ───────────────────────────────────────────────────────────────

const SAMPLE_SQL = `CREATE TABLE users (
  id INT PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(120) UNIQUE NOT NULL,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE orders (
  id INT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  order_number VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL,
  total_amount DECIMAL(10,2) NOT NULL
);

CREATE TABLE order_items (
  id INT PRIMARY KEY,
  order_id INT NOT NULL,
  product_name VARCHAR(120) NOT NULL,
  quantity INT NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  CONSTRAINT fk_order FOREIGN KEY (order_id) REFERENCES orders(id)
);`;

// ─── Excalidraw ───────────────────────────────────────────────────────────────

const Excalidraw = dynamic(
  () => import("@excalidraw/excalidraw").then((m) => m.Excalidraw),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center bg-white text-gray-400 text-sm">
        Loading canvas…
      </div>
    ),
  },
);

const LEGEND = [
  { color: "bg-blue-200 border-blue-400", label: "Entity (Table)" },
  { color: "bg-amber-100 border-amber-500", label: "Primary Key" },
  { color: "bg-emerald-100 border-emerald-500", label: "Foreign Key" },
  { color: "bg-white border-gray-400", label: "Attribute" },
  { color: "bg-yellow-100 border-yellow-500", label: "Relationship" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ERDiagramPage() {
  const [sql, setSql] = useState(SAMPLE_SQL);
  const [model, setModel] = useState<DiagramModel>(() =>
    parseSqlSchema(SAMPLE_SQL),
  );
  const [layoutSeed, setLayoutSeed] = useState(42);
  const [error, setError] = useState("");
  const [panelOpen, setPanelOpen] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [excalidrawKey, setExcalidrawKey] = useState(0);
  const excalidrawApiRef = useRef<any>(null);

  const layout = useMemo(
    () => buildLayout(model, layoutSeed),
    [model, layoutSeed],
  );

  const initialData = useMemo(
    () => ({
      elements: buildElements(layout),
      appState: {
        viewBackgroundColor: "#f8fafc",
        theme: "light" as const,
        currentItemRoughness: 0,
        zoom: { value: 0.75 as const },
      },
      scrollToContent: true,
    }),
    [layout],
  );

  const handleGenerate = () => {
    setGenerating(true);
    setTimeout(() => {
      try {
        const parsed = parseSqlSchema(sql);
        if (!parsed.entities.length) {
          setError("No CREATE TABLE statements found. Please check your SQL.");
          setGenerating(false);
          return;
        }
        // New random seed every time → different layout arrangement
        const newSeed = Math.floor(Math.random() * 0xffffff);
        setModel(parsed);
        setLayoutSeed(newSeed);
        setExcalidrawKey((k) => k + 1);
        setError("");
      } catch (e: any) {
        setError("Parse error: " + e.message);
      }
      setGenerating(false);
    }, 80);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSql(await file.text());
    e.target.value = "";
  };

  const getSnapshot = () => {
    const api = excalidrawApiRef.current;
    if (!api) return null;
    return {
      elements: api.getSceneElements(),
      appState: {
        ...api.getAppState(),
        exportWithDarkMode: false,
        viewBackgroundColor: "#ffffff",
      },
    };
  };

  const exportAs = async (format: "png" | "jpg" | "svg") => {
    const snap = getSnapshot();
    if (!snap) return;
    const mod = await import("@excalidraw/excalidraw");
    if (format === "svg") {
      const svg = await mod.exportToSvg({
        ...snap,
        exportPadding: 32,
        exportBackground: true,
      });
      dl(
        new Blob([new XMLSerializer().serializeToString(svg)], {
          type: "image/svg+xml",
        }),
        "erd.svg",
      );
    } else {
      dl(
        await mod.exportToBlob({
          ...snap,
          format,
          exportPadding: 32,
          exportBackground: true,
        }),
        `erd.${format}`,
      );
    }
  };

  const dl = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), {
      href: url,
      download: name,
    }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const tableCount = model.entities.length;
  const colCount = model.entities.reduce((s, e) => s + e.attributes.length, 0);
  const relCount = model.entities.reduce(
    (s, e) =>
      s + e.attributes.filter((a) => a.isForeign && a.references).length,
    0,
  );

  const PANEL_W = 440;

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-gray-50 font-sans text-gray-900">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <header className="relative z-30 flex h-13 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4 shadow-sm">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 shadow shadow-blue-200">
            <svg
              viewBox="0 0 16 16"
              fill="none"
              className="h-4 w-4"
              stroke="white"
              strokeWidth="1.7"
            >
              <rect x="1.5" y="3.5" width="5" height="4" rx="0.75" />
              <rect x="9.5" y="8.5" width="5" height="4" rx="0.75" />
              <path d="M6.5 5.5h3v5h-3" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-bold tracking-tight text-gray-900">
              SQL <span className="text-blue-600">ERD</span>
            </span>
            <span className="hidden text-[10px] font-medium text-gray-400 sm:block">
              Entity Relationship Diagram
            </span>
          </div>

          {/* Stats */}
          <div className="ml-4 hidden items-center divide-x divide-gray-200 rounded-lg border border-gray-200 bg-gray-50 sm:flex">
            {[
              { n: tableCount, label: "tables" },
              { n: colCount, label: "columns" },
              { n: relCount, label: "relations" },
            ].map(({ n, label }) => (
              <div
                key={label}
                className="flex items-baseline gap-1 px-3 py-1.5"
              >
                <span className="text-sm font-bold text-blue-600 tabular-nums">
                  {n}
                </span>
                <span className="text-xs text-gray-400">{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {/* Toggle panel */}
          <button
            onClick={() => setPanelOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 shadow-sm transition hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900"
          >
            <svg
              viewBox="0 0 14 10"
              fill="none"
              className="h-3.5 w-3.5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            >
              <path d="M1 1h12M1 5h7M1 9h9" />
            </svg>
            {panelOpen ? "Hide SQL" : "Show SQL"}
          </button>

          {/* Generate */}
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow shadow-blue-200 transition hover:bg-blue-700 active:scale-95 disabled:opacity-60"
          >
            {generating ? (
              <svg
                className="h-3.5 w-3.5 animate-spin"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="6" cy="6" r="4" strokeOpacity="0.25" />
                <path d="M6 2a4 4 0 0 1 4 4" />
              </svg>
            ) : (
              <svg viewBox="0 0 10 12" fill="currentColor" className="h-3 w-3">
                <polygon points="0,0 10,6 0,12" />
              </svg>
            )}
            {generating ? "Generating…" : "Generate ERD"}
          </button>

          <div className="h-6 w-px bg-gray-200" />

          {/* Export buttons */}
          {(["png", "jpg", "svg"] as const).map((fmt) => (
            <button
              key={fmt}
              onClick={() => exportAs(fmt)}
              className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-gray-500 shadow-sm transition hover:border-gray-300 hover:bg-gray-50 hover:text-gray-800"
            >
              {fmt}
            </button>
          ))}
        </div>
      </header>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div className="relative flex-1 overflow-hidden">
        {/* Canvas — positioned absolutely so closing the panel truly gives it 100% width */}
        <div
          className="absolute inset-0 transition-all duration-300"
          style={{ right: panelOpen ? PANEL_W : 0 }}
        >
          <Excalidraw
            key={excalidrawKey}
            initialData={initialData}
            excalidrawAPI={(api: any) => {
              excalidrawApiRef.current = api;
            }}
            UIOptions={{
              canvasActions: {
                changeViewBackgroundColor: false,
                toggleTheme: false,
                saveToActiveFile: false,
                loadScene: false,
                export: false,
              },
            }}
          />
        </div>

        {/* SQL Side Panel — absolute on the right, slides in/out */}
        <aside
          className="absolute inset-y-0 right-0 z-20 flex flex-col border-l border-gray-200 bg-white shadow-xl transition-transform duration-300"
          style={{
            width: PANEL_W,
            transform: panelOpen ? "translateX(0)" : `translateX(${PANEL_W}px)`,
          }}
        >
          {/* Panel header */}
          <div className="flex shrink-0 items-center justify-between border-b border-gray-100 bg-gray-50 px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                SQL Schema
              </span>
            </div>
            <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 shadow-sm transition hover:bg-gray-50 hover:text-gray-900">
              <svg
                viewBox="0 0 14 14"
                fill="none"
                className="h-3.5 w-3.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M7 1v8M4 6l3 3 3-3" />
                <path d="M2 11h10" />
              </svg>
              Import .sql
              <input
                type="file"
                accept=".sql,.txt"
                onChange={handleImport}
                className="hidden"
              />
            </label>
          </div>

          {/* Textarea */}
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            spellCheck={false}
            className="flex-1 resize-none bg-white p-4 font-mono text-[12.5px] leading-relaxed text-gray-800 outline-none placeholder-gray-300 selection:bg-blue-100"
            placeholder="-- Paste your CREATE TABLE statements here…"
          />

          {/* Legend */}
          <div className="shrink-0 border-t border-gray-100 bg-gray-50 px-4 py-3">
            <p className="mb-2 text-[9px] font-bold uppercase tracking-widest text-gray-400">
              Legend
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {LEGEND.map(({ color, label }) => (
                <div key={label} className="flex items-center gap-1.5">
                  <div
                    className={`h-3 w-3 shrink-0 rounded-sm border ${color}`}
                  />
                  <span className="text-[11px] text-gray-500">{label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Generate CTA */}
          <div className="shrink-0 border-t border-gray-100 p-3">
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white shadow shadow-blue-200 transition hover:bg-blue-700 disabled:opacity-60"
            >
              {generating ? (
                <>
                  <svg
                    className="h-4 w-4 animate-spin"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="6" cy="6" r="4" strokeOpacity="0.25" />
                    <path d="M6 2a4 4 0 0 1 4 4" />
                  </svg>
                  Generating…
                </>
              ) : (
                "⚡ Generate ER Diagram"
              )}
            </button>
            <p className="mt-2 text-center text-[10px] text-gray-400">
              Each click randomizes the layout arrangement
            </p>
          </div>
        </aside>
      </div>

      {/* ── Error Toast ──────────────────────────────────────────────────── */}
      {error && (
        <div className="absolute bottom-6 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-xl border border-red-200 bg-white px-5 py-3 text-xs font-medium text-red-600 shadow-xl">
          <span className="mr-1.5">⚠</span>
          {error}
        </div>
      )}
    </div>
  );
}
