"use client";

import dynamic from "next/dynamic";
import { useMemo, useState, useRef } from "react";

// - Types -

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

// - SQL Parser -

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

// - Layout (with random seed) -

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
  const ATT_RX = 66,
    ATT_RY = 23;
  const MIN_ARC_GAP = 18;

  // Two-ring layout constants
  // Attributes <= INNER_MAX go on the inner ring; the rest overflow to the outer ring.
  // This caps the footprint: even a 20-attr entity fits in ~330px radius vs ~490px single-ring.
  const INNER_MAX = 7; // max attrs on inner ring
  const INNER_R = 175; // inner ring orbit radius
  const OUTER_R = 305; // outer ring orbit radius (between the two rings lines can pass)

  // Effective safe radius of an entity: outer edge of outermost ring + padding
  function safeRForCount(count: number): number {
    if (count <= INNER_MAX) {
      // Single ring — use minimum circumference-based radius
      const minR =
        count <= 1
          ? INNER_R
          : Math.max(
              INNER_R,
              (count * (ATT_RX * 2 + MIN_ARC_GAP)) / (2 * Math.PI),
            );
      return minR + ATT_RX + 22;
    }
    // Two rings — safe radius is outer ring edge
    return OUTER_R + ATT_RX + 22;
  }

  // How many attrs on inner vs outer ring
  function splitRings(count: number): { inner: number; outer: number } {
    if (count <= INNER_MAX) return { inner: count, outer: 0 };
    // Split roughly half-half, but inner ring maxes at INNER_MAX
    const inner = INNER_MAX;
    const outer = count - inner;
    return { inner, outer };
  }

  // Inner ring radius — spread evenly if fewer than INNER_MAX
  function innerOrbit(innerCount: number): number {
    if (innerCount <= 1) return INNER_R;
    const minR = (innerCount * (ATT_RX * 2 + MIN_ARC_GAP)) / (2 * Math.PI);
    return Math.max(INNER_R, minR);
  }

  // Outer ring radius — always at least OUTER_R, may grow if too many attrs
  function outerOrbit(outerCount: number): number {
    if (outerCount <= 1) return OUTER_R;
    const minR = (outerCount * (ATT_RX * 2 + MIN_ARC_GAP)) / (2 * Math.PI);
    return Math.max(OUTER_R, minR);
  }

  const entitySafeR = model.entities.map((e) =>
    safeRForCount(e.attributes.length),
  );
  const maxSafeR = Math.max(...entitySafeR, 200);
  const CELL_W = maxSafeR * 2 + 160;
  const CELL_H = maxSafeR * 2 + 160;
  const PAD = 360;
  const n = model.entities.length;

  // Adjacency weights
  const adjMap = new Map<string, number>();
  const relDegree = new Map<string, number>();
  for (const ent of model.entities) {
    const srcName = getShortName(ent.name).toLowerCase();
    for (const attr of ent.attributes) {
      if (!attr.isForeign || !attr.references) continue;
      const tgtName = getShortName(attr.references).toLowerCase();
      if (tgtName === srcName) continue;
      const edgeKey = [srcName, tgtName].sort().join(":");
      adjMap.set(edgeKey, (adjMap.get(edgeKey) ?? 0) + 1);
      relDegree.set(srcName, (relDegree.get(srcName) ?? 0) + 1);
      relDegree.set(tgtName, (relDegree.get(tgtName) ?? 0) + 1);
    }
  }

  // Sort most-connected first
  const sortedEntities = [...model.entities].sort((a, b) => {
    const da = relDegree.get(getShortName(a.name).toLowerCase()) ?? 0;
    const db = relDegree.get(getShortName(b.name).toLowerCase()) ?? 0;
    return db - da;
  });

  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / cols);
  const canvasW = Math.max(2600, cols * CELL_W + PAD * 2);
  const canvasH = Math.max(1800, rows * CELL_H + PAD * 2);

  // BFS spiral from grid centre
  function spiralSlots(
    numCols: number,
    numRows: number,
  ): Array<[number, number]> {
    const slots: Array<[number, number]> = [];
    const visited = new Set<string>();
    const cCol = Math.floor(numCols / 2),
      cRow = Math.floor(numRows / 2);
    const queue: Array<[number, number]> = [[cCol, cRow]];
    visited.add(cCol + "," + cRow);
    while (queue.length > 0) {
      const item = queue.shift()!;
      const c = item[0],
        r = item[1];
      if (c >= 0 && c < numCols && r >= 0 && r < numRows) slots.push([c, r]);
      const nb: Array<[number, number]> = [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
        [1, -1],
        [1, 1],
        [-1, 1],
        [-1, -1],
      ];
      for (const d of nb) {
        const nc = c + d[0],
          nr = r + d[1];
        const k = nc + "," + nr;
        if (
          !visited.has(k) &&
          nc >= 0 &&
          nc < numCols &&
          nr >= 0 &&
          nr < numRows
        ) {
          visited.add(k);
          queue.push([nc, nr]);
        }
      }
    }
    return slots;
  }

  const slots = spiralSlots(cols, rows);

  // Greedy placement
  const slotAssignment = new Map<string, [number, number]>();
  const usedSlots = new Set<string>();
  for (const ent of sortedEntities) {
    const entName = getShortName(ent.name).toLowerCase();
    let bestSlot: [number, number] = slots.find(
      (s) => !usedSlots.has(s[0] + "," + s[1]),
    ) ?? [0, 0];
    let bestScore = -Infinity;
    for (const slot of slots) {
      const c = slot[0],
        r = slot[1];
      if (usedSlots.has(c + "," + r)) continue;
      let score = 0;
      const deltas: Array<[number, number]> = [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ];
      for (const d of deltas) {
        const nc = c + d[0],
          nr = r + d[1];
        for (const [placedName, placed] of slotAssignment) {
          if (placed[0] === nc && placed[1] === nr) {
            const edgeKey = [entName, placedName].sort().join(":");
            const w = adjMap.get(edgeKey) ?? 0;
            score += Math.abs(d[0]) === 1 && Math.abs(d[1]) === 1 ? w * 0.5 : w;
          }
        }
      }
      const slotIdx = slots.findIndex((s) => s[0] === c && s[1] === r);
      if (score - slotIdx * 0.01 > bestScore) {
        bestScore = score - slotIdx * 0.01;
        bestSlot = [c, r];
      }
    }
    slotAssignment.set(entName, bestSlot);
    usedSlots.add(bestSlot[0] + "," + bestSlot[1]);
  }

  // Build two-ring attribute layout
  // Inner ring: first INNER_MAX attrs (or all if count <= INNER_MAX)
  // Outer ring: remaining attrs
  // startAngle randomised per entity so each generate looks different
  function buildRing(
    ent: LayoutEntity,
    modelEnt: DiagramEntity,
    startAngle: number,
  ): LayoutAttribute[] {
    const attrs = modelEnt.attributes;
    const total = attrs.length;
    const { inner: innerCount, outer: outerCount } = splitRings(total);
    const iOrbit = innerOrbit(innerCount);
    const oOrbit = outerOrbit(outerCount);
    const result: LayoutAttribute[] = [];

    attrs.forEach((attr, j) => {
      const isOuter = j >= innerCount;
      const ringIdx = isOuter ? j - innerCount : j;
      const ringSize = isOuter ? outerCount : innerCount;
      const orbit = isOuter ? oOrbit : iOrbit;
      // Stagger outer ring by half a slot so it interleaves with inner ring visually
      const ringStartAngle = isOuter
        ? startAngle + Math.PI / ringSize
        : startAngle;
      const angle =
        ringSize === 1
          ? -Math.PI / 2
          : ringStartAngle + (2 * Math.PI * ringIdx) / ringSize;
      const ax = ent.cx + orbit * Math.cos(angle);
      const ay = ent.cy + orbit * Math.sin(angle);
      const lineStart = rectEdgePoint(ent, { x: ax, y: ay });
      const lineEnd = ellipseEdgePoint(ax, ay, ATT_RX, ATT_RY, lineStart);
      result.push({
        id: ent.id + "-attr-" + attr.name.toLowerCase().replace(/\W+/g, "_"),
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

    return result;
  }

  // Segment vs padded-ellipse hit test
  function segHitsEllipse(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    ex: number,
    ey: number,
    erx: number,
    ery: number,
    pad: number = 12,
  ): boolean {
    const rx2 = erx + pad,
      ry2 = ery + pad;
    const dx = bx - ax,
      dy = by - ay;
    const fx = (ax - ex) / rx2,
      fy = (ay - ey) / ry2;
    const dxn = dx / rx2,
      dyn = dy / ry2;
    const a = dxn * dxn + dyn * dyn;
    if (a < 1e-12) return false;
    const b2 = fx * dxn + fy * dyn;
    const c = fx * fx + fy * fy - 1;
    const disc = b2 * b2 - a * c;
    if (disc < 0) return false;
    const sq = Math.sqrt(disc);
    const t1 = (-b2 - sq) / a,
      t2 = (-b2 + sq) / a;
    return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1) || (t1 < 0 && t2 > 1);
  }

  function pointInsideSafeZone(
    px: number,
    py: number,
    ent: LayoutEntity,
    attrCount: number,
  ): boolean {
    return Math.hypot(px - ent.cx, py - ent.cy) < safeRForCount(attrCount);
  }

  function segCrossings(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    allEnts: LayoutEntity[],
  ): number {
    let hits = 0;
    for (const e of allEnts)
      for (const a of e.attributes)
        if (segHitsEllipse(ax, ay, bx, by, a.x, a.y, a.rx, a.ry)) hits++;
    return hits;
  }

  // Place entities
  const entities: LayoutEntity[] = model.entities.map((ent) => {
    const entName = getShortName(ent.name).toLowerCase();
    const assigned = slotAssignment.get(entName) ?? [0, 0];
    const cx = PAD + assigned[0] * CELL_W + CELL_W / 2;
    const cy = PAD + assigned[1] * CELL_H + CELL_H / 2;
    const entity: LayoutEntity = {
      id: "ent-" + ent.name.toLowerCase().replace(/\W+/g, "_"),
      name: getShortName(ent.name),
      x: cx - ENT_W / 2,
      y: cy - ENT_H / 2,
      width: ENT_W,
      height: ENT_H,
      cx,
      cy,
      attributes: [],
    };
    entity.attributes = buildRing(entity, ent, rng() * Math.PI * 2);
    return entity;
  });

  const attrCountMap = new Map<string, number>();
  for (const ent of model.entities)
    attrCountMap.set(
      "ent-" + ent.name.toLowerCase().replace(/\W+/g, "_"),
      ent.attributes.length,
    );

  // Relationship list - deduplicated: one diamond per unique src->tgt pair
  type RelInfo = { srcId: string; tgtId: string };
  const relsSeen = new Set<string>();
  const rels: RelInfo[] = [];
  for (const ent of entities) {
    for (const attr of ent.attributes) {
      if (!attr.isForeign || !attr.references) continue;
      const tgt = entities.find(
        (e) =>
          getShortName(e.name).toLowerCase() ===
          getShortName(attr.references!).toLowerCase(),
      );
      if (!tgt || tgt.id === ent.id) continue;
      const rk = ent.id + ":" + tgt.id;
      if (relsSeen.has(rk)) continue;
      relsSeen.add(rk);
      rels.push({ srcId: ent.id, tgtId: tgt.id });
    }
  }

  // Pass 1: rotate rings to minimise crossings with relationship lines
  const ANGLE_STEPS = 90;
  for (const ent of entities) {
    const modelEnt = model.entities.find(
      (e) => getShortName(e.name) === ent.name,
    )!;
    if (!modelEnt) continue;
    const myRels = rels.filter((r) => r.srcId === ent.id || r.tgtId === ent.id);
    if (myRels.length === 0) continue;
    const mySafeR = safeRForCount(modelEnt.attributes.length);
    let bestAngle = 0,
      bestHits = Infinity;
    for (let step = 0; step < ANGLE_STEPS; step++) {
      const angle = (step / ANGLE_STEPS) * Math.PI * 2;
      const ring = buildRing(ent, modelEnt, angle);
      let hits = 0;
      for (const rel of myRels) {
        const src = entities.find((e) => e.id === rel.srcId)!;
        const tgt = entities.find((e) => e.id === rel.tgtId)!;
        if (!src || !tgt) continue;
        const axDx = tgt.cx - src.cx,
          axDy = tgt.cy - src.cy;
        const axLen = Math.hypot(axDx, axDy) || 1;
        const isSource = ent.id === src.id;
        const bx =
          (isSource ? src.cx : tgt.cx) +
          (axDx / axLen) * (isSource ? 1 : -1) * (mySafeR + 30);
        const by =
          (isSource ? src.cy : tgt.cy) +
          (axDy / axLen) * (isSource ? 1 : -1) * (mySafeR + 30);
        const entEdge = rectEdgePoint(ent, { x: bx, y: by });
        for (const a of ring)
          if (
            segHitsEllipse(entEdge.x, entEdge.y, bx, by, a.x, a.y, a.rx, a.ry)
          )
            hits++;
      }
      if (hits < bestHits) {
        bestHits = hits;
        bestAngle = angle;
        if (bestHits === 0) break;
      }
    }
    ent.attributes = buildRing(ent, modelEnt, bestAngle);
  }

  // Pass 2: optimal diamond placement
  // Key insight: each relationship gets a unique random axis offset so even when
  // two rels share the same corridor, their diamonds land at different distances
  // and never stack. We also penalise proximity to already-placed diamonds.
  const diamondPositions = new Map<string, Point>();
  const DIAMOND_MIN_DIST = 90; // minimum px between any two diamond centres

  for (const rel of rels) {
    const src = entities.find((e) => e.id === rel.srcId)!;
    const tgt = entities.find((e) => e.id === rel.tgtId)!;
    if (!src || !tgt) continue;

    const srcCount = attrCountMap.get(src.id) ?? 0;
    const tgtCount = attrCountMap.get(tgt.id) ?? 0;
    const srcSafeR = safeRForCount(srcCount);
    const tgtSafeR = safeRForCount(tgtCount);
    const key = rel.srcId + ":" + rel.tgtId;

    const axDx = tgt.cx - src.cx,
      axDy = tgt.cy - src.cy;
    const axLen = Math.hypot(axDx, axDy) || 1;
    const ux = axDx / axLen,
      uy = axDy / axLen;
    const perpX = -uy,
      perpY = ux;
    const midX = (src.cx + tgt.cx) / 2,
      midY = (src.cy + tgt.cy) / 2;
    const axStartX = src.cx + ux * (srcSafeR + 10),
      axStartY = src.cy + uy * (srcSafeR + 10);
    const axEndX = tgt.cx - ux * (tgtSafeR + 10),
      axEndY = tgt.cy - uy * (tgtSafeR + 10);
    const axSpan = Math.hypot(axEndX - axStartX, axEndY - axStartY);

    // Per-relationship random seed so each diamond gets a unique preferred position
    // even when sharing the same axis corridor with another relationship
    const relRng = makeRng(
      (rel.srcId + rel.tgtId)
        .split("")
        .reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, seed),
    );
    // Random preferred t along axis [0.2 .. 0.8] and preferred perp offset [-120..120]
    const preferredT = 0.2 + relRng() * 0.6;
    const preferredPerp = (relRng() - 0.5) * 240;
    const preferredX =
      axStartX + (axEndX - axStartX) * preferredT + perpX * preferredPerp;
    const preferredY =
      axStartY + (axEndY - axStartY) * preferredT + perpY * preferredPerp;

    // Dense candidate grid — axis steps + perpendicular offsets
    const candidates: Point[] = [];

    // Always include the preferred position first so it wins on tie-break
    candidates.push({ x: preferredX, y: preferredY });

    for (let ai = 0; ai <= 16; ai++) {
      const t = ai / 16;
      const bx = axStartX + (axEndX - axStartX) * t;
      const by = axStartY + (axEndY - axStartY) * t;
      for (const d of [0, 50, 100, 160, 230, 310, 400, 500]) {
        for (const s of d === 0 ? [0] : [1, -1])
          candidates.push({ x: bx + perpX * d * s, y: by + perpY * d * s });
      }
    }
    // Extra wide perp sweeps from thirds of the axis
    for (const frac of [1 / 4, 1 / 2, 3 / 4]) {
      const bx = axStartX + (axEndX - axStartX) * frac;
      const by = axStartY + (axEndY - axStartY) * frac;
      for (const d of [70, 150, 240, 340, 460]) {
        for (const s of [1, -1])
          candidates.push({ x: bx + perpX * d * s, y: by + perpY * d * s });
      }
    }

    let bestPos = { x: preferredX, y: preferredY };
    let bestScore = Infinity;

    for (const cand of candidates) {
      if (pointInsideSafeZone(cand.x, cand.y, src, srcCount)) continue;
      if (pointInsideSafeZone(cand.x, cand.y, tgt, tgtCount)) continue;

      const srcEdge = rectEdgePoint(src, cand);
      const tgtEdge = rectEdgePoint(tgt, cand);

      // Count attribute crossings
      const hits =
        segCrossings(srcEdge.x, srcEdge.y, cand.x, cand.y, entities) +
        segCrossings(cand.x, cand.y, tgtEdge.x, tgtEdge.y, entities);

      // Penalty for being too close to an already-placed diamond
      let overlapPenalty = 0;
      for (const [, placed] of diamondPositions) {
        const dToDiamond = Math.hypot(cand.x - placed.x, cand.y - placed.y);
        if (dToDiamond < DIAMOND_MIN_DIST) {
          // Strong penalty that grows as distance shrinks
          overlapPenalty += (DIAMOND_MIN_DIST - dToDiamond) * 80;
        }
      }

      // Distance from preferred position (encourages spread)
      const distFromPreferred = Math.hypot(
        cand.x - preferredX,
        cand.y - preferredY,
      );

      // Distance from midpoint (secondary tiebreak — prefer central diamonds)
      const distFromMid = Math.hypot(cand.x - midX, cand.y - midY);

      const score =
        hits * 10000 +
        overlapPenalty +
        distFromPreferred * 0.5 +
        distFromMid * 0.1;

      if (score < bestScore) {
        bestScore = score;
        bestPos = cand;
      }
    }

    diamondPositions.set(key, bestPos);
  }

  (entities as any).__diamonds = diamondPositions;
  return { width: canvasW, height: canvasH, entities };
}

// Excalidraw Element Builder

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
  strokeColor: "#1e40af",
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
  backgroundColor: "#ffffff",
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
  strokeColor: "#92400e",
  backgroundColor: "#fef3c7",
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
  const w = text.length * fontSize * 0.62 + 16,
    h = fontSize * 1.4;
  return {
    ...BASE,
    id: eid(),
    type: "text",
    x: x - w / 2,
    y: y - h / 2,
    width: w,
    height: h,
    strokeColor: "#1e293b",
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

function diamondEdgePt(
  mx: number,
  my: number,
  DW: number,
  DH: number,
  tx: number,
  ty: number,
): Point {
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
}

// Label floated perpendicularly beside the midpoint of a segment
function sideLabel(p1: Point, p2: Point, text: string): ExElement {
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  const dx = p2.x - p1.x,
    dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len,
    py = dx / len;
  const offset = 18;
  return makeText(mx + px * offset, my + py * offset, text, 12, true, {
    strokeColor: "#374151",
  });
}

function buildElements(layout: DiagramLayout): ExElement[] {
  const diamonds: Map<string, Point> =
    (layout.entities as any).__diamonds ?? new Map();
  const DW = 116,
    DH = 52;

  // Painter's algorithm: draw in layers so shapes always sit on top of lines.
  // Layer 0 - relationship lines (deepest)
  // Layer 1 - spoke lines from entity to attributes
  // Layer 2 - entity rects + attribute ellipses + diamond shapes (mid)
  // Layer 3 - all text labels (top)
  const relLines: ExElement[] = [];
  const spokeLines: ExElement[] = [];
  const shapes: ExElement[] = [];
  const labels: ExElement[] = [];

  // - Spoke lines + ellipses + entity rects -
  for (const ent of layout.entities) {
    // Entity rectangle goes in shapes layer
    shapes.push(makeRect(ent.x, ent.y, ent.width, ent.height));
    labels.push(
      makeText(ent.cx, ent.cy, ent.name, 16, true, { strokeColor: "#1e3a8a" }),
    );

    for (const attr of ent.attributes) {
      // Spoke: draw from entity rect edge TOWARD the ellipse, but stop 6px
      // short of the ellipse surface so the line visually "plugs into" the
      // ellipse rather than poking through it.
      const dx = attr.lineEnd.x - attr.lineStart.x;
      const dy = attr.lineEnd.y - attr.lineStart.y;
      const len = Math.hypot(dx, dy) || 1;
      // Shorten end by 6px so ellipse cleanly covers the tip
      const ex = attr.lineEnd.x - (dx / len) * 6;
      const ey = attr.lineEnd.y - (dy / len) * 6;

      spokeLines.push(
        makeLine(attr.lineStart.x, attr.lineStart.y, ex, ey, {
          strokeColor: "#cbd5e1",
          strokeWidth: 1.2,
        }),
      );

      const bg = attr.isPrimary
        ? "#fef3c7"
        : attr.isForeign
          ? "#dcfce7"
          : "#ffffff";
      const sc = attr.isPrimary
        ? "#b45309"
        : attr.isForeign
          ? "#15803d"
          : "#475569";

      shapes.push(
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
        shapes.push(
          makeEllipse(
            attr.x - attr.rx + ins,
            attr.y - attr.ry + ins,
            (attr.rx - ins) * 2,
            (attr.ry - ins) * 2,
            {
              backgroundColor: "transparent",
              strokeColor: "#b45309",
              strokeWidth: 1,
            },
          ),
        );
      }

      labels.push(
        makeText(attr.x, attr.y, attr.label, 12, attr.isPrimary, {
          strokeColor: attr.isPrimary
            ? "#92400e"
            : attr.isForeign
              ? "#14532d"
              : "#374151",
        }),
      );
    }
  }

  // - Relationship lines + diamonds -
  // Guard against duplicate diamonds when multiple FK columns point to the same table
  const drawnRels = new Set<string>();

  for (const ent of layout.entities) {
    for (const attr of ent.attributes) {
      if (!attr.isForeign || !attr.references) continue;
      const tgt = layout.entities.find(
        (e) =>
          getShortName(e.name).toLowerCase() ===
          getShortName(attr.references!).toLowerCase(),
      );
      if (!tgt) continue;

      const key = ent.id + ":" + tgt.id;
      if (drawnRels.has(key)) continue;
      drawnRels.add(key);

      const dpos = diamonds.get(key) ?? {
        x: (ent.cx + tgt.cx) / 2,
        y: (ent.cy + tgt.cy) / 2,
      };
      const dmx = dpos.x,
        dmy = dpos.y;

      // Diamond shape (goes in shapes so it paints over spoke lines)
      shapes.push(makeDiamond(dmx - DW / 2, dmy - DH / 2, DW, DH));
      labels.push(
        makeText(dmx, dmy, "has", 12, true, { strokeColor: "#92400e" }),
      );

      // Source entity → diamond  (relationship line, behind everything)
      const srcPt = rectEdgePoint(ent, { x: dmx, y: dmy });
      const dEntry = diamondEdgePt(dmx, dmy, DW, DH, srcPt.x, srcPt.y);
      relLines.push(
        makeLine(srcPt.x, srcPt.y, dEntry.x, dEntry.y, {
          strokeColor: "#64748b",
          strokeWidth: 1.5,
        }),
      );
      labels.push(sideLabel(srcPt, dEntry, "1"));

      // Diamond → target entity
      const tgtPt = rectEdgePoint(tgt, { x: dmx, y: dmy });
      const dExit = diamondEdgePt(dmx, dmy, DW, DH, tgtPt.x, tgtPt.y);
      relLines.push(
        makeLine(dExit.x, dExit.y, tgtPt.x, tgtPt.y, {
          strokeColor: "#64748b",
          strokeWidth: 1.5,
          endArrowhead: "arrow",
        }),
      );
      labels.push(sideLabel(dExit, tgtPt, "N"));
    }
  }

  // Compose final array in painter's order:
  // rel lines → spoke lines → shapes (rects/ellipses/diamonds) → labels
  return [...relLines, ...spokeLines, ...shapes, ...labels];
}

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

// - Excalidraw -

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

// - Page -

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

  const PANEL_W = 440;
  const toolbarButtonBase =
    "flex h-10 shrink-0 items-center gap-2 rounded-[12px] px-3 text-xs font-medium transition";
  const renderToolbarPill = (className: string) => (
    <div className={className}>
      <div className="flex items-center gap-1 rounded-[18px] border border-gray-200/90 bg-white/95 p-1.5 shadow-[0_10px_28px_rgba(15,23,42,0.08)] backdrop-blur-sm">
        <div className="flex h-10 shrink-0 items-center gap-2 rounded-[12px] bg-gray-50 px-2.5 text-gray-700 ring-1 ring-gray-200/80">
          {/* Logo */}
          <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[#ecebff] text-[#4338ca]">
            <svg
              viewBox="0 0 16 16"
              fill="none"
              className="h-3.5 w-3.5"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <rect x="1.5" y="3.5" width="5" height="4" rx="0.75" />
              <rect x="9.5" y="8.5" width="5" height="4" rx="0.75" />
              <path d="M6.5 5.5h3v5h-3" strokeLinejoin="round" />
            </svg>
          </div>

          <span className="pr-1 text-xs font-semibold tracking-[0.02em] text-gray-700">
            SQL ERD
          </span>
        </div>

        <div className="h-7 w-px bg-gray-200" />

        {/* Toggle SQL panel */}
        <button
          onClick={() => setPanelOpen((v) => !v)}
          title={panelOpen ? "Hide SQL panel" : "Show SQL panel"}
          className={`${toolbarButtonBase} ${
            panelOpen
              ? "bg-[#ecebff] text-[#4338ca] ring-1 ring-[#d9d7ff]"
              : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
          }`}
        >
          <svg
            viewBox="0 0 14 10"
            fill="none"
            className="h-3 w-3"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          >
            <path d="M1 1h12M1 5h7M1 9h9" />
          </svg>
          {panelOpen ? "Hide SQL" : "Show SQL"}
        </button>

        <button
          onClick={handleGenerate}
          disabled={generating}
          className={`${toolbarButtonBase} bg-[#ecebff] px-3.5 font-semibold text-[#4338ca] ring-1 ring-[#d9d7ff] hover:bg-[#e3e2ff] disabled:opacity-60 active:scale-[0.98]`}
        >
          {generating ? (
            <svg
              className="h-3 w-3 animate-spin"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="6" cy="6" r="4" strokeOpacity="0.3" />
              <path d="M6 2a4 4 0 0 1 4 4" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 10 12"
              fill="currentColor"
              className="h-2.5 w-2.5"
            >
              <polygon points="0,0 10,6 0,12" />
            </svg>
          )}
          {generating ? "Generating…" : "Generate ERD"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-white font-sans">
      {renderToolbarPill(
        "absolute left-1/2 top-3 z-30 -translate-x-1/2 md:hidden",
      )}

      {/* - Body - */}
      <div className="relative h-full w-full">
        {/* Canvas */}
        <div
          className="absolute inset-0 transition-all duration-300"
          style={{ right: panelOpen ? PANEL_W : 0 }}
        >
          <Excalidraw
            key={excalidrawKey}
            initialData={initialData}
            renderTopRightUI={(isMobile) =>
              isMobile
                ? null
                : renderToolbarPill(
                    "pointer-events-auto",
                  )
            }
            excalidrawAPI={(api: any) => {
              excalidrawApiRef.current = api;
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

      {/* - Error Toast - */}
      {error && (
        <div className="absolute bottom-6 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-xl border border-red-200 bg-white px-5 py-3 text-xs font-medium text-red-600 shadow-xl">
          <span className="mr-1.5">⚠</span>
          {error}
        </div>
      )}
    </div>
  );
}
