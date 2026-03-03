"use client";

import dynamic from "next/dynamic";
import { useMemo, useState, useCallback } from "react";
import { format as formatSql } from "sql-formatter";
import Editor from "@monaco-editor/react";

type DiagramAttribute = {
  name: string;
  type: string;
  isPrimary: boolean;
  isForeign: boolean;
  references?: string; // normalized table name if this column references another table
};

type DiagramEntity = {
  name: string;
  attributes: DiagramAttribute[];
};

type DiagramModel = {
  entities: DiagramEntity[];
};

type Point = {
  x: number;
  y: number;
};

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
  centerX: number;
  centerY: number;
  attributes: LayoutAttribute[];
};

type DiagramLayout = {
  width: number;
  height: number;
  entities: LayoutEntity[];
};

const Excalidraw = dynamic(
  () => import("@excalidraw/excalidraw").then((module) => module.Excalidraw),
  { ssr: false },
);

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
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id)
);`;

function stripIdentifierQuotes(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function normalizeIdentifier(raw: string): string {
  return raw
    .split(".")
    .map((part) => stripIdentifierQuotes(part))
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
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | "`" | "]" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quote) {
      if (quote === "]") {
        if (char === "]") {
          quote = null;
        }
        continue;
      }

      if (char === quote) {
        if (quote === "'" && input[index + 1] === "'") {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === "[") {
      quote = "]";
      continue;
    }

    if (char === "(") {
      depth += 1;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (char === "," && depth === 0) {
      const section = input.slice(start, index).trim();
      if (section) {
        chunks.push(section);
      }
      start = index + 1;
    }
  }

  const trailing = input.slice(start).trim();
  if (trailing) {
    chunks.push(trailing);
  }

  return chunks;
}

function parseIdentifierList(input: string): string[] {
  return splitTopLevelComma(input).map((part) => normalizeIdentifier(part));
}

function extractCreateTableBlocks(
  sql: string,
): Array<{ tableName: string; body: string }> {
  const cleaned = removeSqlComments(sql);
  const blocks: Array<{ tableName: string; body: string }> = [];
  const createTableRegex = /create\s+table\s+(?:if\s+not\s+exists\s+)?/gi;

  while (createTableRegex.exec(cleaned) !== null) {
    let cursor = createTableRegex.lastIndex;

    while (cursor < cleaned.length && /\s/.test(cleaned[cursor] ?? "")) {
      cursor += 1;
    }

    const tableNameStart = cursor;
    while (cursor < cleaned.length && cleaned[cursor] !== "(") {
      cursor += 1;
    }

    if (cursor >= cleaned.length) {
      break;
    }

    const rawTableName = cleaned.slice(tableNameStart, cursor).trim();
    const bodyStart = cursor + 1;
    let depth = 0;
    let closingIndex = -1;
    let quote: "'" | '"' | "`" | "]" | null = null;

    for (cursor = bodyStart; cursor < cleaned.length; cursor += 1) {
      const char = cleaned[cursor];

      if (quote) {
        if (quote === "]") {
          if (char === "]") {
            quote = null;
          }
          continue;
        }

        if (char === quote) {
          if (quote === "'" && cleaned[cursor + 1] === "'") {
            cursor += 1;
          } else {
            quote = null;
          }
        }
        continue;
      }

      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        continue;
      }

      if (char === "[") {
        quote = "]";
        continue;
      }

      if (char === "(") {
        depth += 1;
        continue;
      }

      if (char === ")") {
        if (depth === 0) {
          closingIndex = cursor;
          break;
        }
        depth -= 1;
      }
    }

    if (closingIndex === -1) {
      break;
    }

    blocks.push({
      tableName: normalizeIdentifier(rawTableName),
      body: cleaned.slice(bodyStart, closingIndex),
    });

    createTableRegex.lastIndex = closingIndex + 1;
  }

  return blocks;
}

function parseSqlSchema(sql: string): DiagramModel {
  const blocks = extractCreateTableBlocks(sql);
  if (blocks.length === 0) {
    return { entities: [] };
  }

  const entities: DiagramEntity[] = [];

  for (const block of blocks) {
    const sections = splitTopLevelComma(block.body);
    const attributes: DiagramAttribute[] = [];
    const primaryKeyColumns = new Set<string>();
    const foreignKeyColumns = new Set<string>();
    const foreignRefs: Record<string, string> = {};

    for (const originalSection of sections) {
      let section = originalSection.trim();
      if (!section) {
        continue;
      }

      if (/^constraint\b/i.test(section)) {
        section = section.replace(
          /^constraint\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[^\s]+)\s+/i,
          "",
        );
      }

      const primaryMatch = section.match(/^primary\s+key\s*\(([^)]+)\)/i);
      if (primaryMatch) {
        parseIdentifierList(primaryMatch[1]).forEach((column) =>
          primaryKeyColumns.add(column.toLowerCase()),
        );
        continue;
      }

      const foreignMatch = section.match(
        /^foreign\s+key\s*\(([^)]+)\)\s*references\s+([^\s(]+)\s*\(([^)]+)\)/i,
      );
      if (foreignMatch) {
        const referenced = normalizeIdentifier(foreignMatch[2]);
        parseIdentifierList(foreignMatch[1]).forEach((column) => {
          const key = column.toLowerCase();
          foreignKeyColumns.add(key);
          foreignRefs[key] = referenced;
        });
        continue;
      }

      const columnMatch = section.match(
        /^("([^"]+)"|`([^`]+)`|\[[^\]]+\]|[^\s]+)\s+([\s\S]+)$/i,
      );
      if (!columnMatch) {
        continue;
      }

      const columnName = normalizeIdentifier(columnMatch[1]);
      const definition = columnMatch[4].trim();
      const keywordIndex = definition.search(
        /\s+(?:not\s+null|null|primary\s+key|references|unique|check|default|constraint|generated|collate|identity|auto_increment)\b/i,
      );
      const type = (
        keywordIndex === -1 ? definition : definition.slice(0, keywordIndex)
      ).trim();
      const extras =
        keywordIndex === -1 ? "" : definition.slice(keywordIndex).trim();

      const isPrimary = /\bprimary\s+key\b/i.test(extras);
      const isForeign = /\breferences\b/i.test(extras);

      if (isPrimary) {
        primaryKeyColumns.add(columnName.toLowerCase());
      }
      if (isForeign) {
        foreignKeyColumns.add(columnName.toLowerCase());
      }

      // check extras for explicit references to extract target table
      let references: string | undefined;
      const refMatch = extras.match(/references\s+([^\s(]+)/i);
      if (refMatch) {
        references = normalizeIdentifier(refMatch[1]);
      }

      attributes.push({
        name: columnName,
        type,
        isPrimary,
        isForeign,
        references,
      });
    }

    entities.push({
      name: block.tableName,
      attributes: attributes.map((attribute) => {
        const key = attribute.name.toLowerCase();
        return {
          ...attribute,
          isPrimary: attribute.isPrimary || primaryKeyColumns.has(key),
          isForeign: attribute.isForeign || foreignKeyColumns.has(key),
          references: attribute.references || foreignRefs[key],
        };
      }),
    });
  }

  return { entities };
}

function hashTextToSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 1;
}

function createRuntimeSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0 || 1;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function shuffleArray<T>(items: T[], random: () => number): T[] {
  const output = [...items];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = output[index];
    output[index] = output[swapIndex];
    output[swapIndex] = current;
  }
  return output;
}

function getRectangleBorderCenterPoint(
  rectangle: Pick<
    LayoutEntity,
    "x" | "y" | "width" | "height" | "centerX" | "centerY"
  >,
  target: Point,
): Point {
  const dx = target.x - rectangle.centerX;
  const dy = target.y - rectangle.centerY;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return {
      x: dx >= 0 ? rectangle.x + rectangle.width : rectangle.x,
      y: rectangle.centerY,
    };
  }

  return {
    x: rectangle.centerX,
    y: dy >= 0 ? rectangle.y + rectangle.height : rectangle.y,
  };
}

function buildDiagramLayout(
  model: DiagramModel,
  randomSeed: number,
): DiagramLayout {
  if (model.entities.length === 0) {
    return { width: 1800, height: 1000, entities: [] };
  }

  const ENTITY_WIDTH = 236;
  const ENTITY_HEIGHT = 92;
  const ATTRIBUTE_RX = 68;
  const ATTRIBUTE_RY = 40;
  const ATTRIBUTE_EDGE_GAP = 96;
  const ATTRIBUTE_RING_PADDING = 36;
  const ATTRIBUTE_MIN_ARC_GAP = 18;
  const CANVAS_PADDING = 220;
  const CONTENT_MARGIN = 220;
  // extra space between cells to avoid attributes of adjacent entities overlapping
  const CELL_GAP = 160;

  const baseOrbitX = ENTITY_WIDTH / 2 + ATTRIBUTE_EDGE_GAP + ATTRIBUTE_RX;
  const baseOrbitY = ENTITY_HEIGHT / 2 + ATTRIBUTE_EDGE_GAP + ATTRIBUTE_RY;
  const averageOrbit = (baseOrbitX + baseOrbitY) / 2;

  const entityMetrics = model.entities.map((entity) => {
    const attributeCount = entity.attributes.length;
    const neededCircumference =
      attributeCount * (ATTRIBUTE_RX * 2 + ATTRIBUTE_MIN_ARC_GAP);
    const orbitScale =
      attributeCount === 0
        ? 1
        : Math.max(
            1,
            neededCircumference / Math.max(1, 2 * Math.PI * averageOrbit),
          );

    const orbitX = baseOrbitX * orbitScale;
    const orbitY = baseOrbitY * orbitScale;
    const halfWidth = orbitX + ATTRIBUTE_RX + ATTRIBUTE_RING_PADDING;
    const halfHeight = orbitY + ATTRIBUTE_RY + ATTRIBUTE_RING_PADDING;

    return {
      entity,
      orbitX,
      orbitY,
      halfWidth,
      halfHeight,
    };
  });

  const maxHalfWidth = Math.max(
    ...entityMetrics.map((metric) => metric.halfWidth),
  );
  const maxHalfHeight = Math.max(
    ...entityMetrics.map((metric) => metric.halfHeight),
  );

  const cellWidth = maxHalfWidth * 2 + 90 + CELL_GAP;
  const cellHeight = maxHalfHeight * 2 + 90 + CELL_GAP;

  const cols = Math.max(1, Math.ceil(Math.sqrt(entityMetrics.length)));
  const rows = Math.ceil(entityMetrics.length / cols);

  const width = Math.ceil(CANVAS_PADDING * 2 + cols * cellWidth);
  const height = Math.ceil(CANVAS_PADDING * 2 + rows * cellHeight);

  const random = createSeededRandom(
    hashTextToSeed(`${randomSeed}:${entityMetrics.length}`),
  );

  const minCenterX = CANVAS_PADDING + maxHalfWidth;
  const maxCenterX = width - CANVAS_PADDING - maxHalfWidth;
  const minCenterY = CANVAS_PADDING + maxHalfHeight;
  const maxCenterY = height - CANVAS_PADDING - maxHalfHeight;

  const slotCenters: Point[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      slotCenters.push({
        x: CANVAS_PADDING + col * cellWidth + cellWidth / 2,
        y: CANVAS_PADDING + row * cellHeight + cellHeight / 2,
      });
    }
  }
  const shuffledSlots = shuffleArray(slotCenters, random);

  const placedCenters: Array<
    Point & { halfWidth: number; halfHeight: number }
  > = [];

  const positionedEntities: LayoutEntity[] = entityMetrics.map(
    (metric, index) => {
      let centerX =
        minCenterX + random() * Math.max(1, maxCenterX - minCenterX);
      let centerY =
        minCenterY + random() * Math.max(1, maxCenterY - minCenterY);
      let placed = false;

      for (let attempt = 0; attempt < 300; attempt += 1) {
        const overlaps = placedCenters.some((center) => {
          const dx = Math.abs(centerX - center.x);
          const dy = Math.abs(centerY - center.y);
          return (
            dx < center.halfWidth + metric.halfWidth + 24 &&
            dy < center.halfHeight + metric.halfHeight + 24
          );
        });

        if (!overlaps) {
          placed = true;
          break;
        }

        if (attempt < 180) {
          centerX =
            minCenterX + random() * Math.max(1, maxCenterX - minCenterX);
          centerY =
            minCenterY + random() * Math.max(1, maxCenterY - minCenterY);
        } else {
          const slot = shuffledSlots[index % shuffledSlots.length] ?? {
            x: width / 2,
            y: height / 2,
          };
          centerX = slot.x;
          centerY = slot.y;
        }
      }

      if (!placed) {
        const slot = shuffledSlots[index % shuffledSlots.length] ?? {
          x: width / 2,
          y: height / 2,
        };
        centerX = slot.x;
        centerY = slot.y;
      }

      placedCenters.push({
        x: centerX,
        y: centerY,
        halfWidth: metric.halfWidth,
        halfHeight: metric.halfHeight,
      });

      const entityX = centerX - ENTITY_WIDTH / 2;
      const entityY = centerY - ENTITY_HEIGHT / 2;

      const entity: LayoutEntity = {
        id: `entity-${metric.entity.name.toLowerCase()}`,
        name: getShortName(metric.entity.name),
        x: entityX,
        y: entityY,
        width: ENTITY_WIDTH,
        height: ENTITY_HEIGHT,
        centerX,
        centerY,
        attributes: [],
      };

      const count = metric.entity.attributes.length;
      if (count > 0) {
        for (
          let attributeIndex = 0;
          attributeIndex < count;
          attributeIndex += 1
        ) {
          const attribute = metric.entity.attributes[attributeIndex];
          const angle =
            count === 1
              ? -Math.PI / 2
              : -Math.PI / 2 + (2 * Math.PI * attributeIndex) / count;

          const x = centerX + metric.orbitX * Math.cos(angle);
          const y = centerY + metric.orbitY * Math.sin(angle);

          const lineStart = getRectangleBorderCenterPoint(entity, { x, y });
          const dx = x - lineStart.x;
          const dy = y - lineStart.y;
          const length = Math.max(1, Math.hypot(dx, dy));
          const ux = (lineStart.x - x) / length;
          const uy = (lineStart.y - y) / length;
          const ellipseScale =
            1 /
            Math.sqrt(
              (ux * ux) / (ATTRIBUTE_RX * ATTRIBUTE_RX) +
                (uy * uy) / (ATTRIBUTE_RY * ATTRIBUTE_RY),
            );
          const lineEnd = {
            x: x + ux * ellipseScale,
            y: y + uy * ellipseScale,
          };

          const suffix = `${attribute.isPrimary ? "*" : ""}${attribute.isForeign ? " fk" : ""}`;
          entity.attributes.push({
            id: `${entity.id}-attr-${attribute.name.toLowerCase()}`,
            x,
            y,
            rx: ATTRIBUTE_RX,
            ry: ATTRIBUTE_RY,
            label: `${attribute.name}${suffix ? ` ${suffix}` : ""}`,
            lineStart,
            lineEnd,
            isPrimary: attribute.isPrimary,
            isForeign: attribute.isForeign,
            references: attribute.references,
          });
        }
      }

      return entity;
    },
  );

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const entity of positionedEntities) {
    minX = Math.min(minX, entity.x - 16);
    minY = Math.min(minY, entity.y - 16);
    maxX = Math.max(maxX, entity.x + entity.width + 16);
    maxY = Math.max(maxY, entity.y + entity.height + 16);

    for (const attribute of entity.attributes) {
      minX = Math.min(
        minX,
        attribute.x - attribute.rx - 12,
        attribute.lineStart.x,
        attribute.lineEnd.x,
      );
      maxX = Math.max(
        maxX,
        attribute.x + attribute.rx + 12,
        attribute.lineStart.x,
        attribute.lineEnd.x,
      );
      minY = Math.min(
        minY,
        attribute.y - attribute.ry - 12,
        attribute.lineStart.y,
        attribute.lineEnd.y,
      );
      maxY = Math.max(
        maxY,
        attribute.y + attribute.ry + 12,
        attribute.lineStart.y,
        attribute.lineEnd.y,
      );
    }
  }

  if (
    Number.isFinite(minX) &&
    Number.isFinite(minY) &&
    Number.isFinite(maxX) &&
    Number.isFinite(maxY)
  ) {
    const shiftX = CONTENT_MARGIN - minX;
    const shiftY = CONTENT_MARGIN - minY;

    for (const entity of positionedEntities) {
      entity.x += shiftX;
      entity.y += shiftY;
      entity.centerX += shiftX;
      entity.centerY += shiftY;

      for (const attribute of entity.attributes) {
        attribute.x += shiftX;
        attribute.y += shiftY;
        attribute.lineStart.x += shiftX;
        attribute.lineStart.y += shiftY;
        attribute.lineEnd.x += shiftX;
        attribute.lineEnd.y += shiftY;
      }
    }

    return {
      width: Math.max(1800, Math.ceil(maxX - minX + CONTENT_MARGIN * 2)),
      height: Math.max(1000, Math.ceil(maxY - minY + CONTENT_MARGIN * 2)),
      entities: positionedEntities,
    };
  }

  return { width, height, entities: positionedEntities };
}

function buildExcalidrawSkeleton(
  layout: DiagramLayout,
): Record<string, unknown>[] {
  const skeleton: Record<string, unknown>[] = [];

  const DIAMOND_WIDTH = 120;
  const DIAMOND_HEIGHT = 30;
  const LINE_OFFSET = 50;

  function getRelationshipType(
    sourceEntity: LayoutEntity,
    targetEntity: LayoutEntity,
    attribute: LayoutAttribute,
  ): string {
    if (attribute.isPrimary && attribute.isForeign) {
      return "";
    }
    return "has";
  }

  function getCardinality(
    sourceEntity: LayoutEntity,
    targetEntity: LayoutEntity,
    attribute: LayoutAttribute,
  ): string {
    if (attribute.isPrimary && attribute.isForeign) {
      return "1-1";
    }
    return "1-n";
  }

  function getCardinalityTarget(
    sourceEntity: LayoutEntity,
    targetEntity: LayoutEntity,
    attribute: LayoutAttribute,
  ): string {
    if (attribute.isPrimary && attribute.isForeign) {
      return "1-1";
    }
    return "n-1";
  }

  function getEntityCornerPoint(
    entity: LayoutEntity,
    targetX: number,
    targetY: number,
  ): Point {
    const dx = targetX - entity.centerX;
    const dy = targetY - entity.centerY;
    const halfW = entity.width / 2;
    const halfH = entity.height / 2;
    const ratio = halfW / halfH;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (absDx / absDy > ratio) {
      return {
        x: entity.x + (dx >= 0 ? entity.width : 0),
        y: entity.centerY,
      };
    }
    return {
      x: entity.centerX,
      y: entity.y + (dy >= 0 ? entity.height : 0),
    };
  }

  function getDiamondEdgePoint(
    diamondX: number,
    diamondY: number,
    targetX: number,
    targetY: number,
  ): Point {
    const hw = DIAMOND_WIDTH / 2;
    const hh = DIAMOND_WIDTH / 2;
    const cx = diamondX + hw;
    const cy = diamondY + hh;
    const dx = targetX - cx;
    const dy = targetY - cy;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (absDx * hh > absDy * hw) {
      const t = hw / absDx;
      return {
        x: cx + dx * t,
        y: cy + dy * t,
      };
    }
    const t = hh / absDy;
    return {
      x: cx + dx * t,
      y: cy + dy * t,
    };
  }

  const shapes: Record<string, unknown>[] = [];
  const arrows: Record<string, unknown>[] = [];

  for (const entity of layout.entities) {
    shapes.push({
      id: entity.id,
      type: "rectangle",
      x: entity.x,
      y: entity.y,
      width: entity.width,
      height: entity.height,
      roughness: 0,
      label: {
        text: entity.name,
      },
    });

    for (const attribute of entity.attributes) {
      shapes.push({
        id: attribute.id,
        type: "ellipse",
        x: attribute.x - attribute.rx,
        y: attribute.y - attribute.ry,
        width: attribute.rx * 2,
        height: attribute.ry * 2,
        roughness: 0,
        label: {
          text: attribute.label,
        },
      });

      if (attribute.isPrimary) {
        const labelWidth = attribute.label.length * 7;
        shapes.push({
          id: `${attribute.id}-underline`,
          type: "line",
          x: attribute.x - labelWidth / 2,
          y: attribute.y + attribute.ry - 2,
          points: [
            [0, 0],
            [labelWidth, 0],
          ],
          roughness: 0,
          strokeStyle: "solid",
        });
      }
    }
  }

  for (const entity of layout.entities) {
    for (const attribute of entity.attributes) {
      if (!attribute.references) continue;
      const target = layout.entities.find(
        (e) =>
          getShortName(e.name).toLowerCase() ===
          getShortName(attribute.references!).toLowerCase(),
      );
      if (!target) continue;
      if (!attribute.isForeign) continue;

      const relType = getRelationshipType(
        entity,
        target,
        attribute,
      );
      const cardinality = getCardinality(
        entity,
        target,
        attribute,
      );

      const midX = (entity.centerX + target.centerX) / 2;
      const midY = (entity.centerY + target.centerY) / 2;

      shapes.push({
        id: `rel-${entity.id}-${target.id}`,
        type: "diamond",
        x: midX - DIAMOND_WIDTH / 2,
        y: midY - DIAMOND_HEIGHT / 2,
        width: DIAMOND_WIDTH,
        height: DIAMOND_HEIGHT,
        roughness: 0,
        label: {
          text: relType,
        },
      });

      const entityCorner = getEntityCornerPoint(entity, midX, midY);
      const dx1 = entityCorner.x < midX ? LINE_OFFSET : -LINE_OFFSET;
      const startX = entityCorner.x + dx1;
      const startY = entityCorner.y;
      const endX = midX + (entityCorner.x < midX ? -DIAMOND_WIDTH / 2 - 5 : DIAMOND_WIDTH / 2 + 5);
      const endY = midY;
      
      arrows.push({
        type: "line",
        x: startX,
        y: startY,
        points: [
          [0, 0],
          [endX - startX, endY - startY],
        ],
        roughness: 0,
        straight: true,
        startArrowhead: null,
        endArrowhead: null,
        label: {
          text: cardinality,
        },
        labelPosition: 0.5,
      });

      const targetCorner = getEntityCornerPoint(target, midX, midY);
      const dx2 = targetCorner.x < midX ? -LINE_OFFSET : LINE_OFFSET;
      const startX2 = targetCorner.x + dx2;
      const startY2 = targetCorner.y;
      const endX2 = midX + (targetCorner.x < midX ? -DIAMOND_WIDTH / 2 - 5 : DIAMOND_WIDTH / 2 + 5);
      const endY2 = midY;

      arrows.push({
        type: "line",
        x: startX2,
        y: startY2,
        points: [
          [0, 0],
          [endX2 - startX2, endY2 - startY2],
        ],
        roughness: 0,
        straight: true,
        startArrowhead: null,
        endArrowhead: null,
        label: {
          text: getCardinalityTarget(entity, target, attribute),
        },
        labelPosition: 0.5,
      });
    }
  }
  }

  for (const entity of layout.entities) {
    for (const attribute of entity.attributes) {
      const dx = attribute.lineEnd.x - attribute.lineStart.x;
      const dy = attribute.lineEnd.y - attribute.lineStart.y;
      const length = Math.hypot(dx, dy);
      const ux = dx / length;
      const uy = dy / length;
      const arrowLen = 12;
      arrows.push({
        type: "arrow",
        x: attribute.lineStart.x,
        y: attribute.lineStart.y,
        points: [
          [0, 0],
          [
            attribute.lineEnd.x - attribute.lineStart.x - ux * arrowLen,
            attribute.lineEnd.y - attribute.lineStart.y - uy * arrowLen,
          ],
        ],
        roughness: 0,
        startArrowhead: null,
        endArrowhead: "arrow",
        roundArrow: false,
      });
    }
  }

  skeleton.push(...shapes, ...arrows);

  return skeleton;
}

function fallbackModel(): DiagramModel {
  try {
    return parseSqlSchema(SAMPLE_SQL);
  } catch {
    return { entities: [] };
  }
}

export default function Home() {
  const [schemaInput, setSchemaInput] = useState(SAMPLE_SQL);
  const [diagram, setDiagram] = useState<DiagramModel>(() => fallbackModel());
  const [errorMessage, setErrorMessage] = useState("");
  const [isSchemaOpen, setIsSchemaOpen] = useState(true);
  const [layoutSeed, setLayoutSeed] = useState(() =>
    hashTextToSeed(SAMPLE_SQL),
  );

  const layout = useMemo(
    () => buildDiagramLayout(diagram, layoutSeed),
    [diagram, layoutSeed],
  );

  const initialData = useMemo(() => {
    const skeleton = buildExcalidrawSkeleton(layout);

    return () =>
      (async () => {
        const { convertToExcalidrawElements } =
          await import("@excalidraw/excalidraw");

        return {
          elements: convertToExcalidrawElements(
            skeleton as Parameters<typeof convertToExcalidrawElements>[0],
          ),
          appState: {
            viewBackgroundColor: "#ffffff",
            theme: "light" as const,
            currentItemRoughness: 0,
          },
          scrollToContent: true,
        };
      })();
  }, [layout]);

  const handleEditorChange = useCallback((value: string | undefined) => {
    if (value !== undefined) {
      setSchemaInput(value);
    }
  }, []);

  const handleGenerate = async (): Promise<void> => {
    let currentSql = schemaInput;

    try {
      currentSql = formatSql(currentSql, { language: "sql", keywordCase: "upper" });
    } catch (e) {
    }

    setSchemaInput(currentSql);

    const parsed = parseSqlSchema(currentSql);
    if (parsed.entities.length === 0) {
      setErrorMessage(
        "No CREATE TABLE statements were found. Paste a SQL schema and try again.",
      );
      setDiagram({ entities: [] });
      return;
    }

    setDiagram(parsed);
    setLayoutSeed(createRuntimeSeed());
    setErrorMessage("");
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    setSchemaInput(text);

    e.target.value = "";
  };

  return (
    <main className="h-screen w-screen bg-slate-100 text-slate-900">
      <div className="absolute left-4 top-4 z-20 flex items-center gap-2 rounded-xl border border-slate-300 bg-white/95 px-3 py-2 shadow-sm">
        <h1 className="text-sm font-semibold">SQL ERD (Excalidraw)</h1>
      </div>

      <div className="absolute right-4 top-4 z-20 flex items-center gap-2 rounded-xl border border-slate-300 bg-white/95 p-2 shadow-sm">
        <button
          type="button"
          onClick={() => setIsSchemaOpen((value) => !value)}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium"
        >
          {isSchemaOpen ? "Hide SQL" : "Show SQL"}
        </button>
        <button
          type="button"
          onClick={() => void handleGenerate()}
          className="rounded-md border border-blue-700 bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white"
        >
          Generate
        </button>
      </div>

      <aside
        className={`absolute right-4 top-16 z-20 flex h-[calc(100vh-5rem)] w-[520px] flex-col gap-3 rounded-2xl border border-slate-300 bg-white/95 p-4 shadow-xl transition-transform min-h-0 ${
          isSchemaOpen ? "translate-x-0" : "translate-x-[570px]"
        }`}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">SQL Schema</h2>
          <label className="cursor-pointer rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm font-medium hover:bg-slate-100">
            Import File
            <input
              type="file"
              accept=".sql,.txt"
              onChange={handleFileImport}
              className="hidden"
            />
          </label>
        </div>
        {isSchemaOpen && (
          <Editor
            height="100%"
            defaultLanguage="sql"
            value={schemaInput}
            onChange={handleEditorChange}
            theme="vs-light"
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              wordWrap: "on",
            }}
          />
        )}
        <p className="text-xs text-slate-600">
          Paste SQL CREATE TABLE statements or import from file, then click Generate to create your ER diagram.
        </p>
      </aside>

      {errorMessage ? (
        <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800 shadow">
          {errorMessage}
        </div>
      ) : null}

      <div className="h-full w-full">
        <Excalidraw
          key={`${layoutSeed}:${diagram.entities.length}`}
          initialData={initialData}
          UIOptions={{
            canvasActions: {
              changeViewBackgroundColor: false,
              toggleTheme: false,
              saveToActiveFile: false,
              loadScene: false,
            },
          }}
          gridModeEnabled
        />
      </div>
    </main>
  );
}
