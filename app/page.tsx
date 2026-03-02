"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Database,
  Play,
  Code,
  FileText,
  ZoomIn,
  ZoomOut,
  Maximize,
  Download,
  X,
  Info,
  Layers,
} from "lucide-react";

// --- Types ---
type DiagramAttribute = {
  name: string;
  type: string;
  isPrimary: boolean;
  isForeign: boolean;
  isNullable: boolean;
  isUnique: boolean;
  isDerived: boolean;
  isMultivalued: boolean;
};

type DiagramEntity = {
  name: string;
  isWeak: boolean;
  attributes: DiagramAttribute[];
};

type DiagramRelationship = {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
};

type DiagramModel = {
  entities: DiagramEntity[];
  relationships: DiagramRelationship[];
};

type PositionedAttribute = {
  attribute: DiagramAttribute;
  x: number;
  y: number;
  rx: number;
  ry: number;
  label: string;
};

type PositionedEntity = {
  entity: DiagramEntity;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  attributes: PositionedAttribute[];
};

type Point = {
  x: number;
  y: number;
};

type RelationshipPath = {
  relationship: DiagramRelationship;
  points: Point[];
  diamond: Point;
  fromCardinality: Cardinality;
  toCardinality: Cardinality;
  fromTotalParticipation: boolean;
  toTotalParticipation: boolean;
  label: string;
};

type DiagramLayout = {
  width: number;
  height: number;
  entities: PositionedEntity[];
  relationshipPaths: RelationshipPath[];
};

type ExportFormat = "png" | "jpg";
type Cardinality = "1" | "N" | "M" | "0..1" | "0..N";

type ViewTransform = {
  scale: number;
  offsetX: number;
  offsetY: number;
  initialized: boolean;
};

// --- Constants ---
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3.0;

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

const BANK_SAMPLE_SQL = `CREATE TABLE bank (
  code VARCHAR(20) PRIMARY KEY,
  bname VARCHAR(120) NOT NULL
);

CREATE TABLE branch (
  branch_code VARCHAR(20) PRIMARY KEY,
  bank_code VARCHAR(20) NOT NULL REFERENCES bank(code),
  blocation VARCHAR(120) NOT NULL,
  bname VARCHAR(120) NOT NULL
);

CREATE TABLE employee (
  eid INT PRIMARY KEY,
  branch_code VARCHAR(20) NOT NULL REFERENCES branch(branch_code),
  designation VARCHAR(80) NOT NULL,
  salary DECIMAL(12,2) NOT NULL
);

CREATE TABLE customer (
  cid INT PRIMARY KEY,
  branch_code VARCHAR(20) NOT NULL REFERENCES branch(branch_code),
  cname VARCHAR(120) NOT NULL,
  address VARCHAR(255) NOT NULL,
  dob DATE NOT NULL
);

CREATE TABLE account (
  acc_no VARCHAR(20) PRIMARY KEY,
  branch_code VARCHAR(20) NOT NULL REFERENCES branch(branch_code),
  customer_id INT NOT NULL REFERENCES customer(cid),
  type VARCHAR(20) NOT NULL
);

CREATE TABLE loan (
  loan_no VARCHAR(20) PRIMARY KEY,
  branch_code VARCHAR(20) NOT NULL REFERENCES branch(branch_code),
  customer_id INT NOT NULL REFERENCES customer(cid),
  amount DECIMAL(12,2) NOT NULL,
  rate DECIMAL(5,2) NOT NULL
);`;

const RELATIONSHIP_LABEL_MAP: Record<string, string> = {
  "branch->bank": "has",
  "employee->branch": "works in",
  "customer->branch": "contains",
  "account->branch": "maintains",
  "loan->branch": "provides",
  "account->customer": "has",
  "loan->customer": "avails",
  "orders->users": "books",
  "order_items->orders": "contains",
};

// --- Parsers & Helpers ---
function getRelationshipLabel(relation: DiagramRelationship): string {
  const from = getShortName(relation.fromTable).toLowerCase();
  const to = getShortName(relation.toTable).toLowerCase();
  const direct = RELATIONSHIP_LABEL_MAP[`${from}->${to}`];
  if (direct) return direct;

  const reverse = RELATIONSHIP_LABEL_MAP[`${to}->${from}`];
  if (reverse) return reverse;

  return "relates";
}

function stripIdentifierQuotes(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
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
        if (char === "]") quote = null;
        continue;
      }
      if (char === quote) {
        if (quote === "'" && input[index + 1] === "'") index += 1;
        else quote = null;
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
      if (section) chunks.push(section);
      start = index + 1;
    }
  }

  const trailing = input.slice(start).trim();
  if (trailing) chunks.push(trailing);

  return chunks;
}

function extractCreateTableBlocks(
  sql: string,
): Array<{ tableName: string; body: string }> {
  const cleaned = removeSqlComments(sql);
  const blocks: Array<{ tableName: string; body: string }> = [];
  const createTableRegex = /create\s+table\s+(?:if\s+not\s+exists\s+)?/gi;

  while (createTableRegex.exec(cleaned) !== null) {
    let cursor = createTableRegex.lastIndex;
    while (cursor < cleaned.length && /\s/.test(cleaned[cursor] ?? ""))
      cursor += 1;
    const tableNameStart = cursor;
    while (cursor < cleaned.length && cleaned[cursor] !== "(") cursor += 1;
    if (cursor >= cleaned.length) break;

    const rawTableName = cleaned.slice(tableNameStart, cursor).trim();
    const bodyStart = cursor + 1;
    let depth = 0;
    let closingIndex = -1;
    let quote: "'" | '"' | "`" | "]" | null = null;

    for (cursor = bodyStart; cursor < cleaned.length; cursor += 1) {
      const char = cleaned[cursor];
      if (quote) {
        if (quote === "]") {
          if (char === "]") quote = null;
          continue;
        }
        if (char === quote) {
          if (quote === "'" && cleaned[cursor + 1] === "'") cursor += 1;
          else quote = null;
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

    if (closingIndex === -1) break;

    blocks.push({
      tableName: normalizeIdentifier(rawTableName),
      body: cleaned.slice(bodyStart, closingIndex),
    });
    createTableRegex.lastIndex = closingIndex + 1;
  }

  return blocks;
}

function parseIdentifierList(input: string): string[] {
  return splitTopLevelComma(input).map((identifier) =>
    normalizeIdentifier(identifier),
  );
}

function buildTableLookup(tableNames: string[]): Map<string, string> {
  const lookup = new Map<string, string>();
  const shortNameCount = new Map<string, number>();

  for (const tableName of tableNames) {
    const short = getShortName(tableName).toLowerCase();
    shortNameCount.set(short, (shortNameCount.get(short) ?? 0) + 1);
  }

  for (const tableName of tableNames) {
    lookup.set(tableName.toLowerCase(), tableName);
    const short = getShortName(tableName).toLowerCase();
    if ((shortNameCount.get(short) ?? 0) === 1) {
      lookup.set(short, tableName);
    }
  }

  return lookup;
}

function resolveTableName(
  rawTableName: string,
  lookup: Map<string, string>,
): string {
  const normalized = normalizeIdentifier(rawTableName);
  const direct = lookup.get(normalized.toLowerCase());
  if (direct) return direct;
  const short = getShortName(normalized).toLowerCase();
  return lookup.get(short) ?? normalized;
}

function parseSqlSchema(sql: string): DiagramModel {
  const blocks = extractCreateTableBlocks(sql);
  if (blocks.length === 0) return { entities: [], relationships: [] };

  const tableNames = blocks.map((block) => block.tableName);
  const tableLookup = buildTableLookup(tableNames);
  const entities: DiagramEntity[] = [];
  const relationships: DiagramRelationship[] = [];

  for (const block of blocks) {
    const tableName = block.tableName;
    const sections = splitTopLevelComma(block.body);
    const attributes: DiagramAttribute[] = [];
    const primaryKeyColumns = new Set<string>();
    const foreignKeyColumns = new Set<string>();
    const uniqueColumns = new Set<string>();

    for (const originalSection of sections) {
      let section = originalSection.trim();
      if (!section) continue;

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

      const uniqueMatch = section.match(/^unique\s*\(([^)]+)\)/i);
      if (uniqueMatch) {
        parseIdentifierList(uniqueMatch[1]).forEach((column) =>
          uniqueColumns.add(column.toLowerCase()),
        );
        continue;
      }

      const foreignMatch = section.match(
        /^foreign\s+key\s*\(([^)]+)\)\s*references\s+([^\s(]+)\s*\(([^)]+)\)/i,
      );
      if (foreignMatch) {
        const sourceColumns = parseIdentifierList(foreignMatch[1]);
        const targetTable = resolveTableName(foreignMatch[2], tableLookup);
        const targetColumns = parseIdentifierList(foreignMatch[3]);

        sourceColumns.forEach((column, index) => {
          const targetColumn = targetColumns[index] ?? targetColumns[0] ?? "id";
          foreignKeyColumns.add(column.toLowerCase());
          relationships.push({
            fromTable: tableName,
            fromColumn: column,
            toTable: targetTable,
            toColumn: targetColumn,
          });
        });
        continue;
      }

      const columnMatch = section.match(
        /^("([^"]+)"|`([^`]+)`|\[[^\]]+\]|[^\s]+)\s+([\s\S]+)$/i,
      );
      if (!columnMatch) continue;

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
      const isUnique = /\bunique\b/i.test(extras);
      const isForeign = /\breferences\b/i.test(extras);
      const isNullable = !/\bnot\s+null\b/i.test(extras);
      const isDerived = /\bgenerated\b|\bas\s*\(/i.test(extras);
      const isMultivalued = /\[\]|\bset\s*\(/i.test(type);

      if (isPrimary) primaryKeyColumns.add(columnName.toLowerCase());
      if (isUnique) uniqueColumns.add(columnName.toLowerCase());
      if (isForeign) {
        foreignKeyColumns.add(columnName.toLowerCase());
        const inlineReference = extras.match(
          /\breferences\s+([^\s(]+)\s*\(([^)]+)\)/i,
        );
        if (inlineReference) {
          const targetTable = resolveTableName(inlineReference[1], tableLookup);
          const targetColumns = parseIdentifierList(inlineReference[2]);
          relationships.push({
            fromTable: tableName,
            fromColumn: columnName,
            toTable: targetTable,
            toColumn: targetColumns[0] ?? "id",
          });
        }
      }

      attributes.push({
        name: columnName,
        type,
        isPrimary,
        isForeign,
        isNullable,
        isUnique,
        isDerived,
        isMultivalued,
      });
    }

    const finalizedAttributes = attributes.map((attribute) => {
      const key = attribute.name.toLowerCase();
      return {
        ...attribute,
        isPrimary: attribute.isPrimary || primaryKeyColumns.has(key),
        isForeign: attribute.isForeign || foreignKeyColumns.has(key),
        isUnique: attribute.isUnique || uniqueColumns.has(key),
      };
    });

    const primaryAttributes = finalizedAttributes.filter(
      (attr) => attr.isPrimary,
    );
    const primaryForeignAttributes = primaryAttributes.filter(
      (attr) => attr.isForeign,
    );
    const isWeak =
      primaryAttributes.length > 0 &&
      primaryAttributes.length === primaryForeignAttributes.length;

    entities.push({
      name: tableName,
      isWeak,
      attributes: finalizedAttributes,
    });
  }

  const dedupedRelationships: DiagramRelationship[] = [];
  const seenRelationshipKeys = new Set<string>();
  for (const relation of relationships) {
    const key =
      `${relation.fromTable}.${relation.fromColumn}->${relation.toTable}.${relation.toColumn}`.toLowerCase();
    if (!seenRelationshipKeys.has(key)) {
      seenRelationshipKeys.add(key);
      dedupedRelationships.push(relation);
    }
  }

  return { entities, relationships: dedupedRelationships };
}

function createAttributeLabel(attribute: DiagramAttribute): string {
  const badges: string[] = [];
  if (attribute.isPrimary) badges.push("PK");
  if (attribute.isForeign) badges.push("FK");
  if (attribute.isUnique) badges.push("UQ");
  if (attribute.isMultivalued) badges.push("MV");
  if (attribute.isDerived) badges.push("DR");

  const suffix = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
  const type = attribute.type ? `: ${attribute.type}` : "";
  return `${attribute.name}${type}${suffix}`;
}

function getRectangleBorderCenterPoint(
  entity: Pick<
    PositionedEntity,
    "x" | "y" | "width" | "height" | "centerX" | "centerY"
  >,
  target: Point,
): Point {
  const dx = target.x - entity.centerX;
  const dy = target.y - entity.centerY;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return {
      x: dx >= 0 ? entity.x + entity.width : entity.x,
      y: entity.centerY,
    };
  }

  return {
    x: entity.centerX,
    y: dy >= 0 ? entity.y + entity.height : entity.y,
  };
}

function hashTextToSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 1;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function createRuntimeSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0 || 1;
}

function shuffleArray<T>(input: T[], random: () => number): T[] {
  const output = [...input];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(random() * (index + 1));
    const current = output[index];
    output[index] = output[randomIndex];
    output[randomIndex] = current;
  }
  return output;
}

// Extract path recalculation so we can call it on drag
function calculateRelationshipPaths(
  entities: PositionedEntity[],
  relationships: DiagramRelationship[],
): RelationshipPath[] {
  const RELATION_DIAMOND_CLEARANCE = 200;
  const RELATION_LANE_STEP = 60;

  const entityLookup = new Map<string, PositionedEntity>();
  for (const entity of entities) {
    entityLookup.set(entity.entity.name.toLowerCase(), entity);
  }

  return relationships
    .map((relation, relationIndex): RelationshipPath | null => {
      const fromEntity = entityLookup.get(relation.fromTable.toLowerCase());
      const toEntity = entityLookup.get(relation.toTable.toLowerCase());
      if (!fromEntity || !toEntity) return null;

      const start = getRectangleBorderCenterPoint(fromEntity, {
        x: toEntity.centerX,
        y: toEntity.centerY,
      });
      const end = getRectangleBorderCenterPoint(toEntity, {
        x: fromEntity.centerX,
        y: fromEntity.centerY,
      });

      const laneOffset = ((relationIndex % 7) - 3) * RELATION_LANE_STEP;
      const horizontalDominant =
        Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);

      const points: Point[] = [];
      let diamond: Point = {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2,
      };

      if (horizontalDominant) {
        const midY = (start.y + end.y) / 2;
        let corridorX = (start.x + end.x) / 2 + laneOffset;
        const minX = Math.min(start.x, end.x) + RELATION_DIAMOND_CLEARANCE;
        const maxX = Math.max(start.x, end.x) - RELATION_DIAMOND_CLEARANCE;
        if (minX < maxX) corridorX = Math.min(maxX, Math.max(minX, corridorX));

        diamond = { x: corridorX, y: midY };
        points.push(
          start,
          { x: corridorX, y: start.y },
          diamond,
          { x: corridorX, y: end.y },
          end,
        );
      } else {
        const midX = (start.x + end.x) / 2;
        let corridorY = (start.y + end.y) / 2 + laneOffset;
        const minY = Math.min(start.y, end.y) + RELATION_DIAMOND_CLEARANCE;
        const maxY = Math.max(start.y, end.y) - RELATION_DIAMOND_CLEARANCE;
        if (minY < maxY) corridorY = Math.min(maxY, Math.max(minY, corridorY));

        diamond = { x: midX, y: corridorY };
        points.push(
          start,
          { x: start.x, y: corridorY },
          diamond,
          { x: end.x, y: corridorY },
          end,
        );
      }

      const fkAttribute = fromEntity.attributes.find(
        (attribute) =>
          attribute.attribute.name.toLowerCase() ===
          relation.fromColumn.toLowerCase(),
      )?.attribute;
      const isOneOnFromSide = Boolean(
        fkAttribute?.isUnique || fkAttribute?.isPrimary,
      );
      const fromCardinality: RelationshipPath["fromCardinality"] =
        fkAttribute?.isNullable
          ? isOneOnFromSide
            ? "0..1"
            : "0..N"
          : isOneOnFromSide
            ? "1"
            : "N";
      const toCardinality: RelationshipPath["toCardinality"] = "1";
      const fromTotalParticipation = fkAttribute
        ? !fkAttribute.isNullable
        : false;
      const toTotalParticipation = false;

      return {
        relationship: relation,
        points,
        diamond,
        fromCardinality,
        toCardinality,
        fromTotalParticipation,
        toTotalParticipation,
        label: getRelationshipLabel(relation),
      };
    })
    .filter((path): path is RelationshipPath => path !== null);
}

function buildDiagramLayout(
  model: DiagramModel,
  randomSeed: number,
): DiagramLayout {
  if (model.entities.length === 0) {
    return { width: 1600, height: 900, entities: [], relationshipPaths: [] };
  }

  const ENTITY_WIDTH = 260;
  const ENTITY_HEIGHT = 80;
  const ATTRIBUTE_RX = 110;
  const ATTRIBUTE_RY = 26;
  const ATTRIBUTE_EDGE_GAP = 130;
  const ATTRIBUTE_SPACING = 80;
  const ATTRIBUTE_CENTER_GAP = 40;
  const CANVAS_PADDING = 200;
  const ATTRIBUTE_SIDE_SPACE = ATTRIBUTE_RX + ATTRIBUTE_EDGE_GAP + 40;
  const CONTENT_MARGIN = 200;

  const maxAttributes = Math.max(
    ...model.entities.map((entity) => Math.max(1, entity.attributes.length)),
  );
  const maxSideAttributes = Math.ceil(maxAttributes / 2);

  const minCenterDistanceX = ENTITY_WIDTH + ATTRIBUTE_SIDE_SPACE * 2 + 160;
  const minCenterDistanceY = Math.max(
    380,
    maxSideAttributes * ATTRIBUTE_SPACING * 0.7 + 220,
  );

  const cols = Math.max(1, Math.ceil(Math.sqrt(model.entities.length)));
  const rows = Math.ceil(model.entities.length / cols);

  const initialWidth = CANVAS_PADDING * 2 + cols * minCenterDistanceX;
  const initialHeight = CANVAS_PADDING * 2 + rows * minCenterDistanceY;
  const random = createSeededRandom(
    hashTextToSeed(`${randomSeed}:${model.entities.length}`),
  );

  const minCenterX = CANVAS_PADDING + ENTITY_WIDTH / 2 + ATTRIBUTE_SIDE_SPACE;
  const maxCenterX =
    initialWidth - CANVAS_PADDING - ENTITY_WIDTH / 2 - ATTRIBUTE_SIDE_SPACE;
  const minCenterY = CANVAS_PADDING + ENTITY_HEIGHT / 2 + 80;
  const maxCenterY = initialHeight - CANVAS_PADDING - ENTITY_HEIGHT / 2 - 80;

  const fallbackSlots: Point[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      fallbackSlots.push({
        x: CANVAS_PADDING + col * minCenterDistanceX + minCenterDistanceX / 2,
        y: CANVAS_PADDING + row * minCenterDistanceY + minCenterDistanceY / 2,
      });
    }
  }
  const shuffledFallbackSlots = shuffleArray(fallbackSlots, random);
  const chosenCenters: Point[] = [];

  const positionedEntities: PositionedEntity[] = model.entities.map(
    (entity, index) => {
      let centerX =
        minCenterX + random() * Math.max(1, maxCenterX - minCenterX);
      let centerY =
        minCenterY + random() * Math.max(1, maxCenterY - minCenterY);
      let placed = false;

      for (let attempt = 0; attempt < 240; attempt += 1) {
        const overlaps = chosenCenters.some((center) => {
          const dx = Math.abs(centerX - center.x);
          const dy = Math.abs(centerY - center.y);
          return dx < minCenterDistanceX * 0.8 && dy < minCenterDistanceY * 0.8;
        });
        if (!overlaps) {
          placed = true;
          break;
        }
        centerX = minCenterX + random() * Math.max(1, maxCenterX - minCenterX);
        centerY = minCenterY + random() * Math.max(1, maxCenterY - minCenterY);
      }

      if (!placed) {
        const fallback = shuffledFallbackSlots[
          index % shuffledFallbackSlots.length
        ] ??
          fallbackSlots[index % fallbackSlots.length] ?? {
            x: initialWidth / 2,
            y: initialHeight / 2,
          };
        centerX = fallback.x;
        centerY = fallback.y;
      }

      chosenCenters.push({ x: centerX, y: centerY });
      const x = centerX - ENTITY_WIDTH / 2;
      const y = centerY - ENTITY_HEIGHT / 2;
      const splitIndex = Math.ceil(entity.attributes.length / 2);
      const leftAttributes = entity.attributes.slice(0, splitIndex);
      const rightAttributes = entity.attributes.slice(splitIndex);
      const attributes: PositionedAttribute[] = [];

      const placeAttributes = (
        source: DiagramAttribute[],
        side: "left" | "right",
      ): void => {
        if (source.length === 0) return;
        const baseY = centerY - ((source.length - 1) * ATTRIBUTE_SPACING) / 2;
        source.forEach((attribute, listIndex) => {
          let yPosition = baseY + listIndex * ATTRIBUTE_SPACING;
          if (Math.abs(yPosition - centerY) < ATTRIBUTE_CENTER_GAP) {
            yPosition +=
              yPosition >= centerY
                ? ATTRIBUTE_CENTER_GAP
                : -ATTRIBUTE_CENTER_GAP;
          }
          const label = createAttributeLabel(attribute);
          const rx = ATTRIBUTE_RX;
          const xPosition =
            side === "left"
              ? x - ATTRIBUTE_EDGE_GAP - rx
              : x + ENTITY_WIDTH + ATTRIBUTE_EDGE_GAP + rx;

          attributes.push({
            attribute,
            x: xPosition,
            y: yPosition,
            rx,
            ry: ATTRIBUTE_RY,
            label,
          });
        });
      };

      placeAttributes(leftAttributes, "left");
      placeAttributes(rightAttributes, "right");

      return {
        entity,
        x,
        y,
        width: ENTITY_WIDTH,
        height: ENTITY_HEIGHT,
        centerX,
        centerY,
        attributes,
      };
    },
  );

  const relationshipPaths = calculateRelationshipPaths(
    positionedEntities,
    model.relationships,
  );

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const entity of positionedEntities) {
    minX = Math.min(minX, entity.x - 18);
    maxX = Math.max(maxX, entity.x + entity.width + 18);
    minY = Math.min(minY, entity.y - 18);
    maxY = Math.max(maxY, entity.y + entity.height + 18);

    for (const attribute of entity.attributes) {
      minX = Math.min(minX, attribute.x - attribute.rx - 20);
      maxX = Math.max(maxX, attribute.x + attribute.rx + 20);
      minY = Math.min(minY, attribute.y - attribute.ry - 16);
      maxY = Math.max(maxY, attribute.y + attribute.ry + 16);
    }
  }

  if (
    Number.isFinite(minX) &&
    Number.isFinite(maxX) &&
    Number.isFinite(minY) &&
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
      }
    }

    for (const route of relationshipPaths) {
      route.diamond.x += shiftX;
      route.diamond.y += shiftY;
      route.points = route.points.map((point) => ({
        x: point.x + shiftX,
        y: point.y + shiftY,
      }));
    }
  }

  const contentWidth =
    Number.isFinite(minX) && Number.isFinite(maxX) ? maxX - minX : initialWidth;
  const contentHeight =
    Number.isFinite(minY) && Number.isFinite(maxY)
      ? maxY - minY
      : initialHeight;
  const width = Math.max(1600, Math.ceil(contentWidth + CONTENT_MARGIN * 2));
  const height = Math.max(900, Math.ceil(contentHeight + CONTENT_MARGIN * 2));

  return { width, height, entities: positionedEntities, relationshipPaths };
}

function clampScale(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

function getFittedTransform(
  layout: DiagramLayout,
  viewportWidth: number,
  viewportHeight: number,
): ViewTransform {
  const sidePadding = 60;
  const topSafeArea = 140;
  const bottomPadding = 60;
  const availableWidth = Math.max(120, viewportWidth - sidePadding * 2);
  const availableHeight = Math.max(
    120,
    viewportHeight - topSafeArea - bottomPadding,
  );

  const fitted = Math.min(
    availableWidth / layout.width,
    availableHeight / layout.height,
  );
  const scale = clampScale(Math.min(1.0, fitted));

  const offsetX = (viewportWidth - layout.width * scale) / 2;
  const offsetY = topSafeArea + (availableHeight - layout.height * scale) / 2;

  return { scale, offsetX, offsetY, initialized: true };
}

// --- Canvas Drawing UI ---
function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const clamped = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + clamped, y);
  context.lineTo(x + width - clamped, y);
  context.quadraticCurveTo(x + width, y, x + width, y + clamped);
  context.lineTo(x + width, y + height - clamped);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - clamped,
    y + height,
  );
  context.lineTo(x + clamped, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - clamped);
  context.lineTo(x, y + clamped);
  context.quadraticCurveTo(x, y, x + clamped, y);
  context.closePath();
}

function drawPillLabel(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  options: { fill: string; stroke: string; text: string; font: string },
): void {
  context.save();
  context.font = options.font;
  context.textAlign = "center";
  context.textBaseline = "middle";

  const width = context.measureText(text).width + 16;
  const height = 24;
  drawRoundedRect(context, x - width / 2, y - height / 2, width, height, 12);
  context.fillStyle = options.fill;
  context.fill();
  context.strokeStyle = options.stroke;
  context.lineWidth = 1.5;
  context.stroke();

  context.fillStyle = options.text;
  context.fillText(text, x, y + 1);
  context.restore();
}

function fitText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (context.measureText(text).width <= maxWidth) return text;
  let output = text;
  while (
    output.length > 1 &&
    context.measureText(`${output}...`).width > maxWidth
  ) {
    output = output.slice(0, -1);
  }
  return `${output}...`;
}

function toRelationToken(cardinality: Cardinality): "1" | "N" {
  return cardinality === "1" || cardinality === "0..1" ? "1" : "N";
}

function drawCanvasDiagram(
  context: CanvasRenderingContext2D,
  layout: DiagramLayout,
  viewportWidth: number,
  viewportHeight: number,
  view: ViewTransform,
): void {
  context.clearRect(0, 0, viewportWidth, viewportHeight);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  // Modern background gradient
  const background = context.createLinearGradient(
    0,
    0,
    viewportWidth,
    viewportHeight,
  );
  background.addColorStop(0, "#f8fafc"); // slate-50
  background.addColorStop(1, "#f1f5f9"); // slate-100
  context.fillStyle = background;
  context.fillRect(0, 0, viewportWidth, viewportHeight);

  // Subtle Dot/Grid pattern (infinitely repeating)
  context.save();
  context.strokeStyle = "rgba(148, 163, 184, 0.25)"; // slate-400 with opacity
  context.lineWidth = 1;
  context.beginPath();
  const gridStep = 40;
  const scaledStep = gridStep * view.scale;
  const offsetX = ((view.offsetX % scaledStep) + scaledStep) % scaledStep;
  const offsetY = ((view.offsetY % scaledStep) + scaledStep) % scaledStep;

  for (let x = offsetX; x <= viewportWidth; x += scaledStep) {
    context.moveTo(x, 0);
    context.lineTo(x, viewportHeight);
  }
  for (let y = offsetY; y <= viewportHeight; y += scaledStep) {
    context.moveTo(0, y);
    context.lineTo(viewportWidth, y);
  }
  context.stroke();
  context.restore();

  if (!layout || layout.entities.length === 0) return;

  context.save();
  context.translate(view.offsetX, view.offsetY);
  context.scale(view.scale, view.scale);

  context.lineCap = "round";
  context.lineJoin = "round";

  // Draw Relationships (Lines & Diamonds)
  for (const route of layout.relationshipPaths) {
    if (route.points.length < 2) continue;

    // Line Path
    context.strokeStyle = "#94a3b8"; // slate-400
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(route.points[0].x, route.points[0].y);
    for (
      let pointIndex = 1;
      pointIndex < route.points.length;
      pointIndex += 1
    ) {
      context.lineTo(route.points[pointIndex].x, route.points[pointIndex].y);
    }
    context.stroke();

    // Total Participation Indicators
    if (route.fromTotalParticipation && route.points.length >= 2) {
      const start = route.points[0];
      const next = route.points[1];
      const dx = next.x - start.x;
      const dy = next.y - start.y;
      const length = Math.max(1, Math.hypot(dx, dy));
      const offX = (-dy / length) * 5;
      const offY = (dx / length) * 5;
      context.beginPath();
      context.moveTo(start.x + offX, start.y + offY);
      context.lineTo(next.x + offX, next.y + offY);
      context.stroke();
    }

    if (route.toTotalParticipation && route.points.length >= 2) {
      const end = route.points[route.points.length - 1];
      const prev = route.points[route.points.length - 2];
      const dx = end.x - prev.x;
      const dy = end.y - prev.y;
      const length = Math.max(1, Math.hypot(dx, dy));
      const offX = (-dy / length) * 5;
      const offY = (dx / length) * 5;
      context.beginPath();
      context.moveTo(end.x + offX, end.y + offY);
      context.lineTo(prev.x + offX, prev.y + offY);
      context.stroke();
    }

    // Cardinality Labels
    const start = route.points[0];
    const next = route.points[1];
    const startDx = next.x - start.x;
    const startDy = next.y - start.y;
    const startLength = Math.max(1, Math.hypot(startDx, startDy));
    const startLabelX =
      start.x + (startDx / startLength) * 44 + (-startDy / startLength) * 16;
    const startLabelY =
      start.y + (startDy / startLength) * 44 + (startDx / startLength) * 16;

    const end = route.points[route.points.length - 1];
    const prev = route.points[route.points.length - 2];
    const endDx = prev.x - end.x;
    const endDy = prev.y - end.y;
    const endLength = Math.max(1, Math.hypot(endDx, endDy));
    const endLabelX =
      end.x + (endDx / endLength) * 44 + (-endDy / endLength) * 16;
    const endLabelY =
      end.y + (endDy / endLength) * 44 + (endDx / endLength) * 16;

    const fromToken = toRelationToken(route.fromCardinality);
    const toToken = toRelationToken(route.toCardinality);
    const relationRatio = `${toToken}-${fromToken}`;

    const pillFont =
      "600 13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    drawPillLabel(context, fromToken, startLabelX, startLabelY, {
      fill: "#eff6ff",
      stroke: "#3b82f6",
      text: "#1d4ed8",
      font: pillFont,
    });
    drawPillLabel(context, toToken, endLabelX, endLabelY, {
      fill: "#eff6ff",
      stroke: "#3b82f6",
      text: "#1d4ed8",
      font: pillFont,
    });

    // Relationship Diamond
    context.font = "600 15px system-ui, -apple-system, sans-serif";
    const relationLabel = fitText(context, route.label, 140);
    const relationTextWidth = context.measureText(relationLabel).width;
    const diamondWidth = Math.min(180, Math.max(120, relationTextWidth + 60));
    const diamondHeight = 64;
    const cx = route.diamond.x;
    const cy = route.diamond.y;

    context.beginPath();
    context.moveTo(cx, cy - diamondHeight / 2);
    context.lineTo(cx + diamondWidth / 2, cy);
    context.lineTo(cx, cy + diamondHeight / 2);
    context.lineTo(cx - diamondWidth / 2, cy);
    context.closePath();
    context.fillStyle = "#fef3c7"; // amber-50
    context.fill();
    context.strokeStyle = "#d97706"; // amber-600
    context.lineWidth = 2.5;
    context.stroke();

    context.fillStyle = "#92400e"; // amber-800
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(relationLabel, cx, cy - 8);

    drawPillLabel(context, relationRatio, cx, cy + 18, {
      fill: "#ffffff",
      stroke: "#f59e0b",
      text: "#b45309",
      font: "600 12px ui-monospace, SFMono-Regular, Menlo, monospace",
    });
  }

  // Draw Entities and Attributes
  for (const posEntity of layout.entities) {
    // Draw connecting lines to attributes first so they go behind
    for (const attr of posEntity.attributes) {
      const isLeft = attr.x < posEntity.centerX;
      const lineStartX = isLeft ? posEntity.x : posEntity.x + posEntity.width;
      const lineStartY = posEntity.centerY;
      const lineEndX = isLeft ? attr.x + attr.rx : attr.x - attr.rx;

      context.beginPath();
      context.moveTo(lineStartX, lineStartY);
      context.lineTo(lineEndX, attr.y);
      context.strokeStyle = "#cbd5e1"; // slate-300
      context.lineWidth = 2;
      context.stroke();
    }

    // Draw Attributes
    for (const attr of posEntity.attributes) {
      context.beginPath();
      context.ellipse(attr.x, attr.y, attr.rx, attr.ry, 0, 0, Math.PI * 2);
      context.fillStyle = attr.attribute.isForeign ? "#eff6ff" : "#ffffff";
      context.fill();

      if (attr.attribute.isDerived) context.setLineDash([6, 4]);
      context.strokeStyle = attr.attribute.isForeign ? "#3b82f6" : "#64748b"; // blue-500 or slate-500
      context.lineWidth = 1.8;
      context.stroke();
      context.setLineDash([]);

      // Multivalued (double border)
      if (attr.attribute.isMultivalued) {
        context.beginPath();
        context.ellipse(
          attr.x,
          attr.y,
          attr.rx + 5,
          attr.ry + 4,
          0,
          0,
          Math.PI * 2,
        );
        context.strokeStyle = attr.attribute.isForeign ? "#3b82f6" : "#64748b";
        context.lineWidth = 1.2;
        context.stroke();
      }

      // Attribute Text
      context.font =
        "500 13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
      context.fillStyle = "#0f172a"; // slate-900
      context.textAlign = "center";
      context.textBaseline = "middle";
      const maxLabelWidth = attr.rx * 1.6;
      const trimmedLabel = fitText(context, attr.label, maxLabelWidth);
      context.fillText(trimmedLabel, attr.x, attr.y + 1);

      // Primary Key Underline
      if (attr.attribute.isPrimary) {
        const textWidth = context.measureText(trimmedLabel).width;
        context.beginPath();
        context.moveTo(attr.x - textWidth / 2, attr.y + 10);
        context.lineTo(attr.x + textWidth / 2, attr.y + 10);
        context.strokeStyle = "#0f172a"; // slate-900
        context.lineWidth = 1.5;
        context.stroke();
      }

      // Foreign Key Tag
      if (attr.attribute.isForeign) {
        drawRoundedRect(
          context,
          attr.x + attr.rx - 32,
          attr.y - attr.ry + 4,
          28,
          16,
          6,
        );
        context.fillStyle = "#dbeafe"; // blue-100
        context.fill();
        context.strokeStyle = "#2563eb"; // blue-600
        context.lineWidth = 1.2;
        context.stroke();

        context.font = "700 9px ui-monospace, SFMono-Regular, monospace";
        context.fillStyle = "#1d4ed8"; // blue-700
        context.fillText("FK", attr.x + attr.rx - 18, attr.y - attr.ry + 13);
      }
    }

    // Weak Entity Double Border
    if (posEntity.entity.isWeak) {
      drawRoundedRect(
        context,
        posEntity.x - 6,
        posEntity.y - 6,
        posEntity.width + 12,
        posEntity.height + 12,
        14,
      );
      context.strokeStyle = "#475569"; // slate-600
      context.lineWidth = 2;
      context.stroke();
    }

    // Entity Body
    drawRoundedRect(
      context,
      posEntity.x,
      posEntity.y,
      posEntity.width,
      posEntity.height,
      12,
    );
    context.save();
    context.shadowColor = "rgba(15, 23, 42, 0.08)";
    context.shadowBlur = 12;
    context.shadowOffsetY = 4;
    context.fillStyle = "#ffffff";
    context.fill();
    context.restore();
    context.strokeStyle = "#1e293b"; // slate-800
    context.lineWidth = 2.5;
    context.stroke();

    // Entity Title
    context.font = "700 22px system-ui, -apple-system, sans-serif";
    context.fillStyle = "#0f172a"; // slate-900
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(
      getShortName(posEntity.entity.name),
      posEntity.centerX,
      posEntity.centerY + 2,
    );
  }

  context.restore();
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function exportCanvasAsImage(
  canvas: HTMLCanvasElement,
  format: ExportFormat,
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const mimeType = format === "png" ? "image/png" : "image/jpeg";

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error("Image export failed.")),
      mimeType,
      format === "jpg" ? 0.95 : undefined,
    );
  });
  triggerBlobDownload(blob, `erd-diagram-${timestamp}.${format}`);
}

// --- Main App Component ---
export default function App() {
  const [schemaInput, setSchemaInput] = useState(SAMPLE_SQL);
  const [diagram, setDiagram] = useState<DiagramModel>(() => {
    try {
      return parseSqlSchema(SAMPLE_SQL);
    } catch {
      return { entities: [], relationships: [] };
    }
  });

  const [layout, setLayout] = useState<DiagramLayout | null>(null);
  const [layoutSeed, setLayoutSeed] = useState(() =>
    hashTextToSeed(SAMPLE_SQL),
  );

  const [errorMessage, setErrorMessage] = useState("");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("png");
  const [isExporting, setIsExporting] = useState(false);
  const [isSchemaOpen, setIsSchemaOpen] = useState(true);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [viewTransform, setViewTransform] = useState<ViewTransform>({
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    initialized: false,
  });

  const [isPanning, setIsPanning] = useState(false);
  const [draggingNode, setDraggingNode] = useState<{
    name: string;
    offsetX: number;
    offsetY: number;
  } | null>(null);

  const panPointerRef = useRef<Point | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Update layout only when diagram / seed updates
  useEffect(() => {
    const computedLayout = buildDiagramLayout(diagram, layoutSeed);
    setLayout(computedLayout);
    // Reset view bounds to center on new diagram
    setViewTransform((prev) => ({ ...prev, initialized: false }));
  }, [diagram, layoutSeed]);

  useEffect(() => {
    const updateViewport = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  // Fit canvas once on fresh layout calculations
  useEffect(() => {
    if (
      layout &&
      viewport.width > 0 &&
      viewport.height > 0 &&
      !viewTransform.initialized
    ) {
      setViewTransform(
        getFittedTransform(layout, viewport.width, viewport.height),
      );
    }
  }, [layout, viewport.width, viewport.height, viewTransform.initialized]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (
      !canvas ||
      !layout ||
      viewport.width === 0 ||
      viewport.height === 0 ||
      !viewTransform.initialized
    )
      return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const context = canvas.getContext("2d");
    if (!context) return;

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawCanvasDiagram(
      context,
      layout,
      viewport.width,
      viewport.height,
      viewTransform,
    );
  }, [layout, viewport, viewTransform]);

  const zoomAtPoint = (
    zoomFactor: number,
    anchorX: number,
    anchorY: number,
  ): void => {
    setViewTransform((prev) => {
      const nextScale = clampScale(prev.scale * zoomFactor);
      const worldX = (anchorX - prev.offsetX) / prev.scale;
      const worldY = (anchorY - prev.offsetY) / prev.scale;
      return {
        ...prev,
        scale: nextScale,
        offsetX: anchorX - worldX * nextScale,
        offsetY: anchorY - worldY * nextScale,
      };
    });
  };

  const handlePointerDown = (
    e: React.PointerEvent<HTMLCanvasElement>,
  ): void => {
    if (e.button !== 0 && e.button !== 1) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const worldX =
      (e.clientX - rect.left - viewTransform.offsetX) / viewTransform.scale;
    const worldY =
      (e.clientY - rect.top - viewTransform.offsetY) / viewTransform.scale;

    if (layout) {
      for (let i = layout.entities.length - 1; i >= 0; i--) {
        const ent = layout.entities[i];
        // Check collision on the Entity bounding box
        if (
          worldX >= ent.x &&
          worldX <= ent.x + ent.width &&
          worldY >= ent.y &&
          worldY <= ent.y + ent.height
        ) {
          setDraggingNode({
            name: ent.entity.name,
            offsetX: worldX - ent.x,
            offsetY: worldY - ent.y,
          });
          e.currentTarget.setPointerCapture(e.pointerId);

          // Re-order entity to top
          setLayout((prev) => {
            if (!prev) return prev;
            const idx = prev.entities.findIndex(
              (e) => e.entity.name === ent.entity.name,
            );
            if (idx > -1) {
              const newEntities = [...prev.entities];
              const [draggedItem] = newEntities.splice(idx, 1);
              newEntities.push(draggedItem);
              return { ...prev, entities: newEntities };
            }
            return prev;
          });
          return;
        }
      }
    }

    e.currentTarget.setPointerCapture(e.pointerId);
    panPointerRef.current = { x: e.clientX, y: e.clientY };
    setIsPanning(true);
  };

  const handlePointerMove = (
    e: React.PointerEvent<HTMLCanvasElement>,
  ): void => {
    // Handling Dragging Entity
    if (draggingNode && layout) {
      const rect = e.currentTarget.getBoundingClientRect();
      const worldX =
        (e.clientX - rect.left - viewTransform.offsetX) / viewTransform.scale;
      const worldY =
        (e.clientY - rect.top - viewTransform.offsetY) / viewTransform.scale;

      const newX = worldX - draggingNode.offsetX;
      const newY = worldY - draggingNode.offsetY;

      setLayout((prev) => {
        if (!prev) return prev;
        const newEntities = prev.entities.map((ent) => {
          if (ent.entity.name === draggingNode.name) {
            const dx = newX - ent.x;
            const dy = newY - ent.y;
            return {
              ...ent,
              x: newX,
              y: newY,
              centerX: ent.centerX + dx,
              centerY: ent.centerY + dy,
              attributes: ent.attributes.map((attr) => ({
                ...attr,
                x: attr.x + dx,
                y: attr.y + dy,
              })),
            };
          }
          return ent;
        });

        // Live recount of paths mapped to the new layout
        const newPaths = calculateRelationshipPaths(
          newEntities,
          diagram.relationships,
        );
        return { ...prev, entities: newEntities, relationshipPaths: newPaths };
      });
      return;
    }

    // Handling Canvas Pan
    if (!panPointerRef.current) return;
    const dx = e.clientX - panPointerRef.current.x;
    const dy = e.clientY - panPointerRef.current.y;
    panPointerRef.current = { x: e.clientX, y: e.clientY };
    setViewTransform((prev) => ({
      ...prev,
      offsetX: prev.offsetX + dx,
      offsetY: prev.offsetY + dy,
    }));
  };

  const endPan = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (draggingNode) {
      setDraggingNode(null);
    } else {
      panPointerRef.current = null;
      setIsPanning(false);
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const anchorX = e.clientX - rect.left;
    const anchorY = e.clientY - rect.top;
    const zoomFactor = Math.exp(-e.deltaY * 0.0015);
    zoomAtPoint(zoomFactor, anchorX, anchorY);
  };

  const handleZoomIn = () =>
    zoomAtPoint(1.15, viewport.width / 2, viewport.height / 2);
  const handleZoomOut = () =>
    zoomAtPoint(1 / 1.15, viewport.width / 2, viewport.height / 2);
  const handleResetView = () => {
    if (layout && viewport.width && viewport.height) {
      setViewTransform(
        getFittedTransform(layout, viewport.width, viewport.height),
      );
    }
  };

  const handleGenerate = (): void => {
    const parsed = parseSqlSchema(schemaInput);
    if (parsed.entities.length === 0) {
      setErrorMessage(
        "No CREATE TABLE statements were found. Paste a SQL schema and try again.",
      );
      setDiagram({ entities: [], relationships: [] });
      return;
    }
    setDiagram(parsed);
    setLayoutSeed(createRuntimeSeed());
    setErrorMessage("");
  };

  const handleLoadBankExample = (): void => {
    setSchemaInput(BANK_SAMPLE_SQL);
    const parsed = parseSqlSchema(BANK_SAMPLE_SQL);
    setDiagram(parsed);
    setLayoutSeed(createRuntimeSeed());
    setErrorMessage("");
    setIsSchemaOpen(true);
  };

  const handleDownload = async (): Promise<void> => {
    if (!canvasRef.current || diagram.entities.length === 0) return;
    setIsExporting(true);
    setErrorMessage("");
    try {
      await exportCanvasAsImage(canvasRef.current, exportFormat);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to export the diagram.",
      );
    } finally {
      setIsExporting(false);
    }
  };

  const zoomPercent = Math.round(viewTransform.scale * 100);

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-50 text-slate-900 font-sans selection:bg-blue-200">
      {/* Canvas */}
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 z-0 touch-none outline-none ${
          draggingNode
            ? "cursor-grabbing"
            : isPanning
              ? "cursor-grabbing"
              : "cursor-grab"
        }`}
        role="img"
        aria-label="ER Diagram Canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onWheel={handleWheel}
      />

      {/* Main Top Header */}
      <header className="absolute top-4 inset-x-4 z-20 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 pointer-events-none">
        {/* Title Logo */}
        <div className="flex items-center gap-2.5 bg-white/95 backdrop-blur shadow-sm border border-slate-200/60 px-4 py-2.5 rounded-xl pointer-events-auto">
          <Database className="w-5 h-5 text-blue-600" />
          <h1 className="font-semibold text-slate-800 tracking-tight">
            Interactive ERD Canvas
          </h1>
        </div>

        {/* Toolbar Center/Right */}
        <div className="flex flex-wrap items-center bg-white/95 backdrop-blur shadow-md border border-slate-200/60 p-1.5 rounded-2xl pointer-events-auto">
          <div className="flex items-center px-2 py-1 gap-1 border-r border-slate-200/80 mr-2 pr-4">
            <button
              onClick={() => setIsSchemaOpen((cur) => !cur)}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <Code className="w-4 h-4" />
              {isSchemaOpen ? "Hide SQL" : "Show SQL"}
            </button>
            <button
              onClick={handleLoadBankExample}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <FileText className="w-4 h-4" />
              Bank Example
            </button>
            <button
              onClick={handleGenerate}
              className="flex items-center gap-2 px-4 py-1.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 rounded-lg shadow-sm transition-all"
            >
              <Play className="w-4 h-4 fill-current" />
              Generate
            </button>
          </div>

          <div className="flex items-center gap-1 border-r border-slate-200/80 mr-2 pr-4">
            <button
              onClick={handleZoomOut}
              className="p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-xs font-semibold text-slate-500 w-12 text-center select-none">
              {zoomPercent}%
            </span>
            <button
              onClick={handleZoomIn}
              className="p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              onClick={handleResetView}
              className="p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors ml-1"
              title="Fit to Screen"
            >
              <Maximize className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-2 pl-2 pr-1">
            <select
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
              className="text-sm font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 cursor-pointer"
            >
              <option value="png">PNG</option>
              <option value="jpg">JPG</option>
            </select>
            <button
              onClick={handleDownload}
              disabled={diagram.entities.length === 0 || isExporting}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:text-slate-900 active:bg-slate-100 rounded-lg shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download className="w-4 h-4" />
              {isExporting ? "Exporting..." : "Export"}
            </button>
          </div>
        </div>
      </header>

      {/* SQL Sidebar Panel */}
      <aside
        className={`absolute top-24 bottom-6 right-4 z-20 w-96 flex flex-col bg-white/95 backdrop-blur-xl border border-slate-200/80 shadow-2xl rounded-2xl overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] origin-right ${
          isSchemaOpen
            ? "translate-x-0 opacity-100 scale-100"
            : "translate-x-8 opacity-0 scale-95 pointer-events-none"
        }`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 bg-white">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <Layers className="w-4 h-4 text-slate-400" />
            SQL Schema
          </h2>
          <button
            onClick={() => setIsSchemaOpen(false)}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <textarea
          className="flex-1 w-full p-5 font-mono text-[13px] leading-relaxed text-slate-700 bg-slate-50 focus:outline-none focus:ring-inset focus:ring-2 focus:ring-blue-500/50 resize-none whitespace-pre overflow-auto"
          value={schemaInput}
          onChange={(e) => setSchemaInput(e.target.value)}
          spellCheck={false}
          placeholder="CREATE TABLE..."
        />

        <div className="p-4 bg-white border-t border-slate-100 flex flex-col gap-3">
          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-blue-50/50 border border-blue-100/50 text-xs text-blue-800">
            <Info className="w-4 h-4 mt-0.5 shrink-0 text-blue-500" />
            <p className="leading-snug">
              Supports{" "}
              <code className="font-semibold text-blue-900">CREATE TABLE</code>,{" "}
              <code className="font-semibold text-blue-900">PRIMARY KEY</code>,{" "}
              <code className="font-semibold text-blue-900">FOREIGN KEY</code>,
              and inline{" "}
              <code className="font-semibold text-blue-900">REFERENCES</code>.
            </p>
          </div>

          <div className="flex items-center justify-between text-xs font-medium text-slate-500 px-1">
            <span className="bg-slate-100 px-2 py-1 rounded-md">
              {diagram.entities.length} Tables
            </span>
            <span className="bg-slate-100 px-2 py-1 rounded-md">
              {diagram.relationships.length} Relationships
            </span>
          </div>
        </div>
      </aside>

      {/* Empty / Initial State Canvas Message */}
      {diagram.entities.length === 0 && !errorMessage && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center pointer-events-none">
          <div className="bg-white/60 backdrop-blur-md px-6 py-4 rounded-2xl shadow-sm border border-slate-200/50 flex flex-col items-center gap-3">
            <Layers className="w-10 h-10 text-slate-300" />
            <p className="text-slate-600 font-medium">
              Paste your SQL schema, then click Generate.
            </p>
          </div>
        </div>
      )}

      {/* Floating Error Message */}
      {errorMessage && (
        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 bg-red-50 text-red-800 px-5 py-3 rounded-xl shadow-lg border border-red-200 max-w-lg text-sm font-medium animate-in slide-in-from-bottom-4 fade-in">
          <Info className="w-5 h-5 text-red-500 shrink-0" />
          {errorMessage}
        </div>
      )}

      {/* Hint Banner */}
      {diagram.entities.length > 0 && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 text-xs font-medium text-slate-500 pointer-events-none tracking-wide select-none bg-white/70 backdrop-blur px-4 py-2 rounded-full shadow-sm border border-slate-200/60">
          Drag tables to reposition • Drag canvas to pan • Scroll to zoom
        </div>
      )}
    </div>
  );
}
