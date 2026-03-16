"use client";

import dynamic from "next/dynamic";
import { useMemo, useState, useCallback, useRef, useEffect } from "react";

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
  ) {
    return t.slice(1, -1).trim();
  }
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
        if (quote === "'" && input[i + 1] === "'") {
          i++;
        } else quote = null;
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

// ─── Layout Engine ────────────────────────────────────────────────────────────

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

function rectEdgePoint(entity: LayoutEntity, target: Point): Point {
  const dx = target.x - entity.cx;
  const dy = target.y - entity.cy;
  if (Math.abs(dx) * entity.height >= Math.abs(dy) * entity.width) {
    return {
      x: entity.x + (dx >= 0 ? entity.width : 0),
      y: entity.cy + (dy * (entity.width / 2)) / Math.max(1, Math.abs(dx)),
    };
  }
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
  const dx = target.x - cx;
  const dy = target.y - cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len,
    uy = dy / len;
  const scale = 1 / Math.sqrt((ux * ux) / (rx * rx) + (uy * uy) / (ry * ry));
  return { x: cx + ux * scale, y: cy + uy * scale };
}

function buildLayout(model: DiagramModel): DiagramLayout {
  if (!model.entities.length) return { width: 1600, height: 900, entities: [] };

  const ENT_W = 200,
    ENT_H = 70;
  const ATT_RX = 72,
    ATT_RY = 26;
  const ORBIT_R = 160;
  const PAD = 280;
  const CELL_W = (ORBIT_R + ATT_RX) * 2 + 120;
  const CELL_H = (ORBIT_R + ATT_RY) * 2 + 120;

  const cols = Math.max(1, Math.ceil(Math.sqrt(model.entities.length)));
  const rows = Math.ceil(model.entities.length / cols);

  const canvasW = Math.max(1600, cols * CELL_W + PAD * 2);
  const canvasH = Math.max(900, rows * CELL_H + PAD * 2);

  const entities: LayoutEntity[] = model.entities.map((ent, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx = PAD + col * CELL_W + CELL_W / 2;
    const cy = PAD + row * CELL_H + CELL_H / 2;
    const x = cx - ENT_W / 2;
    const y = cy - ENT_H / 2;

    const entity: LayoutEntity = {
      id: `ent-${ent.name.toLowerCase().replace(/\W+/g, "_")}`,
      name: getShortName(ent.name),
      x,
      y,
      width: ENT_W,
      height: ENT_H,
      cx,
      cy,
      attributes: [],
    };

    const count = ent.attributes.length;
    ent.attributes.forEach((attr, j) => {
      // distribute attributes evenly around the entity
      const angle =
        count === 1 ? -Math.PI / 2 : -Math.PI / 2 + (2 * Math.PI * j) / count;

      const orbitX = ORBIT_R + ATT_RX * 0.4;
      const orbitY = ORBIT_R + ATT_RY * 0.4;

      const ax = cx + orbitX * Math.cos(angle);
      const ay = cy + orbitY * Math.sin(angle);

      const lineStart = rectEdgePoint(entity, { x: ax, y: ay });
      const lineEnd = ellipseEdgePoint(ax, ay, ATT_RX, ATT_RY, lineStart);

      const label =
        attr.name + (attr.isPrimary ? " (PK)" : attr.isForeign ? " (FK)" : "");

      entity.attributes.push({
        id: `${entity.id}-attr-${attr.name.toLowerCase().replace(/\W+/g, "_")}`,
        x: ax,
        y: ay,
        rx: ATT_RX,
        ry: ATT_RY,
        label,
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
function eid() {
  return `el-${_eid++}-${Math.random().toString(36).slice(2)}`;
}

function makeRect(
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Record<string, unknown> = {},
): ExElement {
  return {
    id: eid(),
    type: "rectangle",
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    opacity: 100,
    strokeColor: "#1e293b",
    backgroundColor: "#dbeafe",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    roundness: { type: 3, value: 6 },
    isDeleted: false,
    frameId: null,
    link: null,
    locked: false,
    groupIds: [],
    seed: Math.floor(Math.random() * 999999),
    version: 1,
    versionNonce: 1,
    ...extra,
  };
}

function makeEllipse(
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Record<string, unknown> = {},
): ExElement {
  return {
    id: eid(),
    type: "ellipse",
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    opacity: 100,
    strokeColor: "#1e293b",
    backgroundColor: "#f0fdf4",
    fillStyle: "solid",
    strokeWidth: 1.5,
    strokeStyle: "solid",
    roughness: 0,
    roundness: { type: 2 },
    isDeleted: false,
    frameId: null,
    link: null,
    locked: false,
    groupIds: [],
    seed: Math.floor(Math.random() * 999999),
    version: 1,
    versionNonce: 1,
    ...extra,
  };
}

function makeDiamond(
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Record<string, unknown> = {},
): ExElement {
  return {
    id: eid(),
    type: "diamond",
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    opacity: 100,
    strokeColor: "#1e293b",
    backgroundColor: "#fef9c3",
    fillStyle: "solid",
    strokeWidth: 1.5,
    strokeStyle: "solid",
    roughness: 0,
    roundness: null,
    isDeleted: false,
    frameId: null,
    link: null,
    locked: false,
    groupIds: [],
    seed: Math.floor(Math.random() * 999999),
    version: 1,
    versionNonce: 1,
    ...extra,
  };
}

function makeText(
  x: number,
  y: number,
  text: string,
  fontSize = 14,
  bold = false,
  extra: Record<string, unknown> = {},
): ExElement {
  const approxW = text.length * fontSize * 0.6 + 16;
  const approxH = fontSize * 1.4;
  return {
    id: eid(),
    type: "text",
    x: x - approxW / 2,
    y: y - approxH / 2,
    width: approxW,
    height: approxH,
    angle: 0,
    opacity: 100,
    strokeColor: "#0f172a",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    roundness: null,
    isDeleted: false,
    frameId: null,
    link: null,
    locked: false,
    groupIds: [],
    seed: Math.floor(Math.random() * 999999),
    version: 1,
    versionNonce: 1,
    text,
    fontSize,
    fontFamily: 3, // monospace
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
}

function makeLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  extra: Record<string, unknown> = {},
): ExElement {
  return {
    id: eid(),
    type: "line",
    x: x1,
    y: y1,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
    angle: 0,
    opacity: 100,
    strokeColor: "#334155",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1.5,
    strokeStyle: "solid",
    roughness: 0,
    roundness: null,
    isDeleted: false,
    frameId: null,
    link: null,
    locked: false,
    groupIds: [],
    seed: Math.floor(Math.random() * 999999),
    version: 1,
    versionNonce: 1,
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
  };
}

function makeArrow(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  label?: string,
  extra: Record<string, unknown> = {},
): ExElement {
  return {
    id: eid(),
    type: "arrow",
    x: x1,
    y: y1,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
    angle: 0,
    opacity: 100,
    strokeColor: "#475569",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1.5,
    strokeStyle: "solid",
    roughness: 0,
    roundness: { type: 2 },
    isDeleted: false,
    frameId: null,
    link: null,
    locked: false,
    groupIds: [],
    seed: Math.floor(Math.random() * 999999),
    version: 1,
    versionNonce: 1,
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
  };
}

function buildElements(layout: DiagramLayout): ExElement[] {
  const elements: ExElement[] = [];

  // Draw entity-attribute lines, ellipses, entity rectangles
  for (const ent of layout.entities) {
    // Entity rectangle
    elements.push(
      makeRect(ent.x, ent.y, ent.width, ent.height, {
        strokeColor: "#1e40af",
        backgroundColor: "#bfdbfe",
        strokeWidth: 2,
      }),
    );
    elements.push(
      makeText(ent.cx, ent.cy, ent.name, 16, true, {
        strokeColor: "#1e3a8a",
      }),
    );

    // Attributes
    for (const attr of ent.attributes) {
      // Line from entity to attribute
      elements.push(
        makeLine(
          attr.lineStart.x,
          attr.lineStart.y,
          attr.lineEnd.x,
          attr.lineEnd.y,
          { strokeColor: "#64748b", strokeWidth: 1.5 },
        ),
      );

      // Ellipse: double ellipse for PK (draw two)
      const bgColor = attr.isPrimary
        ? "#fef3c7"
        : attr.isForeign
          ? "#dcfce7"
          : "#f8fafc";
      const strokeColor = attr.isPrimary
        ? "#92400e"
        : attr.isForeign
          ? "#14532d"
          : "#334155";
      elements.push(
        makeEllipse(
          attr.x - attr.rx,
          attr.y - attr.ry,
          attr.rx * 2,
          attr.ry * 2,
          {
            backgroundColor: bgColor,
            strokeColor,
            strokeWidth: attr.isPrimary ? 2 : 1.5,
          },
        ),
      );
      // Double ellipse border for PK
      if (attr.isPrimary) {
        const inset = 4;
        elements.push(
          makeEllipse(
            attr.x - attr.rx + inset,
            attr.y - attr.ry + inset,
            (attr.rx - inset) * 2,
            (attr.ry - inset) * 2,
            {
              backgroundColor: "transparent",
              strokeColor: "#92400e",
              strokeWidth: 1,
            },
          ),
        );
      }

      // Attribute label (underline for PK shown via bold)
      elements.push(
        makeText(attr.x, attr.y, attr.label, 12, attr.isPrimary, {
          strokeColor: attr.isPrimary
            ? "#78350f"
            : attr.isForeign
              ? "#14532d"
              : "#1e293b",
        }),
      );
    }
  }

  // Draw relationships (FK → referenced table) with diamond
  for (const ent of layout.entities) {
    for (const attr of ent.attributes) {
      if (!attr.isForeign || !attr.references) continue;

      const targetEnt = layout.entities.find(
        (e) =>
          getShortName(e.name).toLowerCase() ===
          getShortName(attr.references!).toLowerCase(),
      );
      if (!targetEnt) continue;

      // Place diamond between the two entity centers
      const mx = (ent.cx + targetEnt.cx) / 2;
      const my = (ent.cy + targetEnt.cy) / 2;
      const DW = 110,
        DH = 54;
      const dx = mx - DW / 2;
      const dy = my - DH / 2;
      const dcx = mx,
        dcy = my;

      elements.push(
        makeDiamond(dx, dy, DW, DH, {
          strokeColor: "#713f12",
          backgroundColor: "#fef9c3",
          strokeWidth: 1.5,
        }),
      );
      elements.push(
        makeText(dcx, dcy, "has", 12, false, {
          strokeColor: "#713f12",
        }),
      );

      // Diamond edge points
      function diamondEdge(tx: number, ty: number): Point {
        const ddx = tx - dcx,
          ddy = ty - dcy;
        const hw = DW / 2,
          hh = DH / 2;
        const adx = Math.abs(ddx),
          ady = Math.abs(ddy);
        if (adx * hh > ady * hw) {
          const t = hw / adx;
          return { x: dcx + ddx * t, y: dcy + ddy * t };
        }
        const t = hh / Math.max(ady, 0.001);
        return { x: dcx + ddx * t, y: dcy + ddy * t };
      }

      // Source entity → diamond
      const srcPt = rectEdgePoint(ent, { x: dcx, y: dcy });
      const dEntry = diamondEdge(srcPt.x, srcPt.y);
      elements.push(
        makeLine(srcPt.x, srcPt.y, dEntry.x, dEntry.y, {
          strokeColor: "#475569",
          strokeWidth: 1.5,
        }),
      );
      // Cardinality labels
      elements.push(
        makeText(
          (srcPt.x + dEntry.x) / 2,
          (srcPt.y + dEntry.y) / 2 - 12,
          "1",
          11,
        ),
      );

      // Diamond → target entity
      const tgtPt = rectEdgePoint(targetEnt, { x: dcx, y: dcy });
      const dExit = diamondEdge(tgtPt.x, tgtPt.y);
      elements.push(
        makeLine(dExit.x, dExit.y, tgtPt.x, tgtPt.y, {
          strokeColor: "#475569",
          strokeWidth: 1.5,
          endArrowhead: "arrow",
        }),
      );
      elements.push(
        makeText(
          (tgtPt.x + dExit.x) / 2,
          (tgtPt.y + dExit.y) / 2 - 12,
          "N",
          11,
        ),
      );
    }
  }

  return elements;
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

// ─── Excalidraw Dynamic Import ────────────────────────────────────────────────

const Excalidraw = dynamic(
  () => import("@excalidraw/excalidraw").then((m) => m.Excalidraw),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full text-slate-400">
        Loading canvas…
      </div>
    ),
  },
);

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ERDiagramPage() {
  const [sql, setSql] = useState(SAMPLE_SQL);
  const [model, setModel] = useState<DiagramModel>(() =>
    parseSqlSchema(SAMPLE_SQL),
  );
  const [error, setError] = useState("");
  const [panelOpen, setPanelOpen] = useState(true);
  const [key, setKey] = useState(0);
  const excalidrawApiRef = useRef<any>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const layout = useMemo(() => buildLayout(model), [model]);

  const initialData = useMemo(() => {
    const elements = buildElements(layout);
    return {
      elements,
      appState: {
        viewBackgroundColor: "#f8fafc",
        theme: "light" as const,
        currentItemRoughness: 0,
        zoom: { value: 0.8 },
        scrollX: 0,
        scrollY: 0,
      },
      scrollToContent: true,
    };
  }, [layout]);

  const handleGenerate = () => {
    try {
      const parsed = parseSqlSchema(sql);
      if (!parsed.entities.length) {
        setError("No CREATE TABLE statements found. Please check your SQL.");
        return;
      }
      setModel(parsed);
      setKey((k) => k + 1);
      setError("");
    } catch (e: any) {
      setError("Parse error: " + e.message);
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setSql(text);
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
        viewBackgroundColor: "#f8fafc",
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
      const blob = new Blob([new XMLSerializer().serializeToString(svg)], {
        type: "image/svg+xml",
      });
      download(blob, "erd.svg");
    } else {
      const blob = await mod.exportToBlob({
        ...snap,
        format,
        exportPadding: 32,
        exportBackground: true,
      });
      download(blob, `erd.${format}`);
    }
  };

  const download = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <main
      style={{
        height: "100vh",
        width: "100vw",
        background: "#f1f5f9",
        fontFamily: "system-ui, sans-serif",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* Top-left title */}
      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          zIndex: 30,
          background: "white",
          border: "1px solid #cbd5e1",
          borderRadius: 10,
          padding: "6px 14px",
          boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>
          ⬡ SQL ER Diagram
        </span>
      </div>

      {/* Top-right toolbar */}
      <div
        style={{
          position: "absolute",
          top: 12,
          right: 12,
          zIndex: 30,
          background: "white",
          border: "1px solid #cbd5e1",
          borderRadius: 10,
          padding: "6px 10px",
          boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <button
          onClick={() => setPanelOpen((v) => !v)}
          style={btnStyle("#f8fafc", "#334155")}
        >
          {panelOpen ? "← Hide SQL" : "Show SQL →"}
        </button>
        <button
          onClick={handleGenerate}
          style={btnStyle("#1d4ed8", "white", true)}
        >
          ⚡ Generate
        </button>
        <div style={{ width: 1, height: 22, background: "#e2e8f0" }} />
        <button
          onClick={() => exportAs("png")}
          style={btnStyle("#f8fafc", "#334155")}
        >
          PNG
        </button>
        <button
          onClick={() => exportAs("jpg")}
          style={btnStyle("#f8fafc", "#334155")}
        >
          JPG
        </button>
        <button
          onClick={() => exportAs("svg")}
          style={btnStyle("#f8fafc", "#334155")}
        >
          SVG
        </button>
      </div>

      {/* SQL Panel */}
      <aside
        style={{
          position: "absolute",
          top: 56,
          right: 12,
          zIndex: 20,
          width: 480,
          height: "calc(100vh - 72px)",
          background: "white",
          border: "1px solid #cbd5e1",
          borderRadius: 12,
          boxShadow: "0 4px 24px rgba(0,0,0,0.10)",
          display: "flex",
          flexDirection: "column",
          gap: 0,
          transition: "transform 0.25s cubic-bezier(.4,0,.2,1)",
          transform: panelOpen ? "translateX(0)" : "translateX(520px)",
          overflow: "hidden",
        }}
      >
        {/* Panel header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 14px 8px",
            borderBottom: "1px solid #e2e8f0",
            background: "#f8fafc",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: "#1e293b" }}>
            SQL Schema
          </span>
          <label
            style={{
              ...btnStyle("#f1f5f9", "#334155"),
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            📂 Import
            <input
              type="file"
              accept=".sql,.txt"
              onChange={handleImport}
              style={{ display: "none" }}
            />
          </label>
        </div>

        {/* Textarea */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          <textarea
            ref={textareaRef}
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            spellCheck={false}
            style={{
              width: "100%",
              height: "100%",
              padding: "12px 14px",
              fontFamily: '"Fira Code", "Cascadia Code", "Consolas", monospace',
              fontSize: 13,
              lineHeight: 1.6,
              border: "none",
              outline: "none",
              resize: "none",
              background: "#fafafa",
              color: "#1e293b",
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* Legend */}
        <div
          style={{
            padding: "8px 14px",
            borderTop: "1px solid #e2e8f0",
            background: "#f8fafc",
            display: "flex",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          {[
            { color: "#bfdbfe", label: "Entity (Table)" },
            { color: "#fef3c7", label: "PK Attribute" },
            { color: "#dcfce7", label: "FK Attribute" },
            { color: "#f8fafc", label: "Attribute" },
            { color: "#fef9c3", label: "Relationship" },
          ].map(({ color, label }) => (
            <div
              key={label}
              style={{ display: "flex", alignItems: "center", gap: 5 }}
            >
              <div
                style={{
                  width: 12,
                  height: 12,
                  background: color,
                  border: "1px solid #94a3b8",
                  borderRadius: 2,
                }}
              />
              <span style={{ fontSize: 11, color: "#64748b" }}>{label}</span>
            </div>
          ))}
        </div>

        {/* Generate button */}
        <div
          style={{
            padding: "10px 14px",
            borderTop: "1px solid #e2e8f0",
            background: "#f8fafc",
          }}
        >
          <button
            onClick={handleGenerate}
            style={{
              ...btnStyle("#1d4ed8", "white", true),
              width: "100%",
              justifyContent: "center",
              fontSize: 13,
            }}
          >
            ⚡ Generate ER Diagram
          </button>
        </div>
      </aside>

      {/* Error toast */}
      {error && (
        <div
          style={{
            position: "absolute",
            bottom: 20,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 40,
            background: "#fef2f2",
            border: "1px solid #fca5a5",
            borderRadius: 8,
            padding: "8px 16px",
            color: "#991b1b",
            fontSize: 13,
            boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
          }}
        >
          ⚠️ {error}
        </div>
      )}

      {/* Canvas */}
      <div style={{ width: "100%", height: "100%" }}>
        <Excalidraw
          key={key}
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
    </main>
  );
}

function btnStyle(
  bg: string,
  color: string,
  primary?: boolean,
): React.CSSProperties {
  return {
    background: bg,
    color,
    border: primary ? "none" : "1px solid #e2e8f0",
    borderRadius: 7,
    padding: "5px 12px",
    fontSize: 12,
    fontWeight: primary ? 600 : 500,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 4,
    boxShadow: primary ? "0 1px 3px rgba(29,78,216,0.3)" : undefined,
  };
}
