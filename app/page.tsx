"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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

const MIN_ZOOM = 0.14;
const MAX_ZOOM = 2.8;

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

function getRelationshipLabel(relation: DiagramRelationship): string {
  const from = getShortName(relation.fromTable).toLowerCase();
  const to = getShortName(relation.toTable).toLowerCase();
  const direct = RELATIONSHIP_LABEL_MAP[`${from}->${to}`];
  if (direct) {
    return direct;
  }

  const reverse = RELATIONSHIP_LABEL_MAP[`${to}->${from}`];
  if (reverse) {
    return reverse;
  }

  return "relates";
}

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

function resolveTableName(rawTableName: string, lookup: Map<string, string>): string {
  const normalized = normalizeIdentifier(rawTableName);
  const direct = lookup.get(normalized.toLowerCase());
  if (direct) {
    return direct;
  }

  const short = getShortName(normalized).toLowerCase();
  return lookup.get(short) ?? normalized;
}

function parseSqlSchema(sql: string): DiagramModel {
  const blocks = extractCreateTableBlocks(sql);

  if (blocks.length === 0) {
    return { entities: [], relationships: [] };
  }

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
      if (!columnMatch) {
        continue;
      }

      const columnName = normalizeIdentifier(columnMatch[1]);
      const definition = columnMatch[4].trim();
      const keywordIndex = definition.search(
        /\s+(?:not\s+null|null|primary\s+key|references|unique|check|default|constraint|generated|collate|identity|auto_increment)\b/i,
      );
      const type = (keywordIndex === -1
        ? definition
        : definition.slice(0, keywordIndex)
      ).trim();
      const extras = keywordIndex === -1 ? "" : definition.slice(keywordIndex).trim();

      const isPrimary = /\bprimary\s+key\b/i.test(extras);
      const isUnique = /\bunique\b/i.test(extras);
      const isForeign = /\breferences\b/i.test(extras);
      const isNullable = !/\bnot\s+null\b/i.test(extras);
      const isDerived = /\bgenerated\b|\bas\s*\(/i.test(extras);
      const isMultivalued = /\[\]|\bset\s*\(/i.test(type);

      if (isPrimary) {
        primaryKeyColumns.add(columnName.toLowerCase());
      }

      if (isUnique) {
        uniqueColumns.add(columnName.toLowerCase());
      }

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
      (attribute) => attribute.isPrimary,
    );
    const primaryForeignAttributes = primaryAttributes.filter(
      (attribute) => attribute.isForeign,
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
    const key = `${relation.fromTable}.${relation.fromColumn}->${relation.toTable}.${relation.toColumn}`.toLowerCase();
    if (!seenRelationshipKeys.has(key)) {
      seenRelationshipKeys.add(key);
      dedupedRelationships.push(relation);
    }
  }

  return {
    entities,
    relationships: dedupedRelationships,
  };
}

function createAttributeLabel(attribute: DiagramAttribute): string {
  const badges: string[] = [];
  if (attribute.isPrimary) {
    badges.push("PK");
  }
  if (attribute.isUnique) {
    badges.push("UQ");
  }
  if (attribute.isMultivalued) {
    badges.push("MV");
  }
  if (attribute.isDerived) {
    badges.push("DR");
  }

  const suffix = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
  const type = attribute.type ? `: ${attribute.type}` : "";
  return `${attribute.name}${type}${suffix}`;
}

function getRectangleBorderCenterPoint(
  entity: Pick<PositionedEntity, "x" | "y" | "width" | "height" | "centerX" | "centerY">,
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

  return (hash >>> 0) || 1;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function createRuntimeSeed(): number {
  return ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0) || 1;
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

function buildDiagramLayout(model: DiagramModel, randomSeed: number): DiagramLayout {
  if (model.entities.length === 0) {
    return { width: 1600, height: 900, entities: [], relationshipPaths: [] };
  }

  const ENTITY_WIDTH = 280;
  const ENTITY_HEIGHT = 104;
  const ATTRIBUTE_RX = 96;
  const ATTRIBUTE_RY = 26;
  const ATTRIBUTE_EDGE_GAP = 132;
  const ATTRIBUTE_SPACING = 84;
  const ATTRIBUTE_CENTER_GAP = 52;
  const RELATION_DIAMOND_CLEARANCE = 180;
  const RELATION_LANE_STEP = 54;
  const CANVAS_PADDING = 220;
  const ATTRIBUTE_SIDE_SPACE = ATTRIBUTE_RX + ATTRIBUTE_EDGE_GAP + 48;

  const maxAttributes = Math.max(
    ...model.entities.map((entity) => Math.max(1, entity.attributes.length)),
  );
  const maxSideAttributes = Math.ceil(maxAttributes / 2);

  const minCenterDistanceX = ENTITY_WIDTH + ATTRIBUTE_SIDE_SPACE * 2 + 120;
  const minCenterDistanceY = Math.max(360, maxSideAttributes * ATTRIBUTE_SPACING * 0.72 + 210);

  const cols = Math.max(1, Math.ceil(Math.sqrt(model.entities.length)));
  const rows = Math.ceil(model.entities.length / cols);

  const width = CANVAS_PADDING * 2 + cols * minCenterDistanceX;
  const height = CANVAS_PADDING * 2 + rows * minCenterDistanceY;
  const random = createSeededRandom(hashTextToSeed(`${randomSeed}:${model.entities.length}`));

  const minCenterX = CANVAS_PADDING + ENTITY_WIDTH / 2 + ATTRIBUTE_SIDE_SPACE;
  const maxCenterX = width - CANVAS_PADDING - ENTITY_WIDTH / 2 - ATTRIBUTE_SIDE_SPACE;
  const minCenterY = CANVAS_PADDING + ENTITY_HEIGHT / 2 + 80;
  const maxCenterY = height - CANVAS_PADDING - ENTITY_HEIGHT / 2 - 80;

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
      let centerX = minCenterX + random() * Math.max(1, maxCenterX - minCenterX);
      let centerY = minCenterY + random() * Math.max(1, maxCenterY - minCenterY);
      let placed = false;

      for (let attempt = 0; attempt < 240; attempt += 1) {
        const overlaps = chosenCenters.some((center) => {
          const dx = Math.abs(centerX - center.x);
          const dy = Math.abs(centerY - center.y);
          return (
            dx < minCenterDistanceX * 0.74 &&
            dy < minCenterDistanceY * 0.74
          );
        });

        if (!overlaps) {
          placed = true;
          break;
        }

        centerX = minCenterX + random() * Math.max(1, maxCenterX - minCenterX);
        centerY = minCenterY + random() * Math.max(1, maxCenterY - minCenterY);
      }

      if (!placed) {
        const fallback =
          shuffledFallbackSlots[index % shuffledFallbackSlots.length] ??
          fallbackSlots[index % fallbackSlots.length] ?? {
            x: width / 2,
            y: height / 2,
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
        if (source.length === 0) {
          return;
        }

        const baseY = centerY - ((source.length - 1) * ATTRIBUTE_SPACING) / 2;

        source.forEach((attribute, listIndex) => {
          let yPosition = baseY + listIndex * ATTRIBUTE_SPACING;
          if (Math.abs(yPosition - centerY) < ATTRIBUTE_CENTER_GAP) {
            yPosition += yPosition >= centerY ? ATTRIBUTE_CENTER_GAP : -ATTRIBUTE_CENTER_GAP;
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

  const entityLookup = new Map<string, PositionedEntity>();
  for (const entity of positionedEntities) {
    entityLookup.set(entity.entity.name.toLowerCase(), entity);
  }

  const relationshipPaths: RelationshipPath[] = model.relationships
    .map((relation, relationIndex): RelationshipPath | null => {
      const fromEntity = entityLookup.get(relation.fromTable.toLowerCase());
      const toEntity = entityLookup.get(relation.toTable.toLowerCase());

      if (!fromEntity || !toEntity) {
        return null;
      }

      const start = getRectangleBorderCenterPoint(fromEntity, {
        x: toEntity.centerX,
        y: toEntity.centerY,
      });
      const end = getRectangleBorderCenterPoint(toEntity, {
        x: fromEntity.centerX,
        y: fromEntity.centerY,
      });

      const laneOffset = ((relationIndex % 7) - 3) * RELATION_LANE_STEP;
      const horizontalDominant = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);

      const points: Point[] = [];
      let diamond: Point = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };

      if (horizontalDominant) {
        const midY = (start.y + end.y) / 2;
        let corridorX = (start.x + end.x) / 2 + laneOffset;
        const minX = Math.min(start.x, end.x) + RELATION_DIAMOND_CLEARANCE;
        const maxX = Math.max(start.x, end.x) - RELATION_DIAMOND_CLEARANCE;
        if (minX < maxX) {
          corridorX = Math.min(maxX, Math.max(minX, corridorX));
        }

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
        if (minY < maxY) {
          corridorY = Math.min(maxY, Math.max(minY, corridorY));
        }

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
          attribute.attribute.name.toLowerCase() === relation.fromColumn.toLowerCase(),
      )?.attribute;
      const isOneOnFromSide = Boolean(fkAttribute?.isUnique || fkAttribute?.isPrimary);
      const fromCardinality: RelationshipPath["fromCardinality"] = fkAttribute?.isNullable
        ? isOneOnFromSide
          ? "0..1"
          : "0..N"
        : isOneOnFromSide
          ? "1"
          : "N";
      const toCardinality: RelationshipPath["toCardinality"] = "1";
      const fromTotalParticipation = fkAttribute ? !fkAttribute.isNullable : false;
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

  return {
    width,
    height,
    entities: positionedEntities,
    relationshipPaths,
  };
}

function clampScale(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

function getFittedTransform(
  layout: DiagramLayout,
  viewportWidth: number,
  viewportHeight: number,
): ViewTransform {
  const sidePadding = 46;
  const topSafeArea = 130;
  const bottomPadding = 34;
  const availableWidth = Math.max(120, viewportWidth - sidePadding * 2);
  const availableHeight = Math.max(120, viewportHeight - topSafeArea - bottomPadding);

  const fitted = Math.min(availableWidth / layout.width, availableHeight / layout.height);
  const scale = clampScale(Math.min(1.25, fitted));

  const offsetX = (viewportWidth - layout.width * scale) / 2;
  const offsetY = topSafeArea + (availableHeight - layout.height * scale) / 2;

  return {
    scale,
    offsetX,
    offsetY,
    initialized: true,
  };
}

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
  context.quadraticCurveTo(x + width, y + height, x + width - clamped, y + height);
  context.lineTo(x + clamped, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - clamped);
  context.lineTo(x, y + clamped);
  context.quadraticCurveTo(x, y, x + clamped, y);
  context.closePath();
}

function fitText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (context.measureText(text).width <= maxWidth) {
    return text;
  }

  let output = text;
  while (output.length > 1 && context.measureText(`${output}...`).width > maxWidth) {
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

  const background = context.createLinearGradient(0, 0, viewportWidth, viewportHeight);
  background.addColorStop(0, "#f5f5f5");
  background.addColorStop(0.56, "#ededed");
  background.addColorStop(1, "#e6e6e6");
  context.fillStyle = background;
  context.fillRect(0, 0, viewportWidth, viewportHeight);

  context.save();
  context.strokeStyle = "rgba(0, 0, 0, 0.06)";
  context.lineWidth = 1;
  context.beginPath();
  const gridStep = 34;
  for (let x = 0; x <= viewportWidth; x += gridStep) {
    context.moveTo(x, 0);
    context.lineTo(x, viewportHeight);
  }
  for (let y = 0; y <= viewportHeight; y += gridStep) {
    context.moveTo(0, y);
    context.lineTo(viewportWidth, y);
  }
  context.stroke();
  context.restore();

  if (layout.entities.length === 0) {
    context.fillStyle = "rgba(18, 18, 18, 0.8)";
    context.font = "600 19px Iowan Old Style, Palatino Linotype, Palatino, Garamond, serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(
      "Paste SQL schema, then click Generate Diagram.",
      viewportWidth / 2,
      viewportHeight / 2,
    );
    return;
  }

  context.save();
  context.translate(view.offsetX, view.offsetY);
  context.scale(view.scale, view.scale);

  drawRoundedRect(context, -8, -8, layout.width + 16, layout.height + 16, 12);
  context.strokeStyle = "rgba(0, 0, 0, 0.16)";
  context.lineWidth = 1.2;
  context.stroke();

  context.strokeStyle = "#161616";
  context.lineWidth = 2;
  context.lineCap = "round";
  context.lineJoin = "round";

  context.font = "600 12px Menlo, Monaco, Consolas, 'Courier New', monospace";
  context.textAlign = "center";
  context.textBaseline = "middle";

  for (const route of layout.relationshipPaths) {
    if (route.points.length < 2) {
      continue;
    }

    context.beginPath();
    context.moveTo(route.points[0].x, route.points[0].y);
    for (let pointIndex = 1; pointIndex < route.points.length; pointIndex += 1) {
      const point = route.points[pointIndex];
      context.lineTo(point.x, point.y);
    }
    context.stroke();

    if (route.fromTotalParticipation && route.points.length >= 2) {
      const start = route.points[0];
      const next = route.points[1];
      const dx = next.x - start.x;
      const dy = next.y - start.y;
      const length = Math.max(1, Math.hypot(dx, dy));
      const offsetX = (-dy / length) * 4;
      const offsetY = (dx / length) * 4;
      context.beginPath();
      context.moveTo(start.x + offsetX, start.y + offsetY);
      context.lineTo(next.x + offsetX, next.y + offsetY);
      context.stroke();
    }

    if (route.toTotalParticipation && route.points.length >= 2) {
      const end = route.points[route.points.length - 1];
      const previous = route.points[route.points.length - 2];
      const dx = end.x - previous.x;
      const dy = end.y - previous.y;
      const length = Math.max(1, Math.hypot(dx, dy));
      const offsetX = (-dy / length) * 4;
      const offsetY = (dx / length) * 4;
      context.beginPath();
      context.moveTo(end.x + offsetX, end.y + offsetY);
      context.lineTo(previous.x + offsetX, previous.y + offsetY);
      context.stroke();
    }

    const start = route.points[0];
    const next = route.points[1];
    const startDx = next.x - start.x;
    const startDy = next.y - start.y;
    const startLength = Math.max(1, Math.hypot(startDx, startDy));
    const startLabelX = start.x + (startDx / startLength) * 28 + (-startDy / startLength) * 11;
    const startLabelY = start.y + (startDy / startLength) * 28 + (startDx / startLength) * 11;

    const end = route.points[route.points.length - 1];
    const previous = route.points[route.points.length - 2];
    const endDx = previous.x - end.x;
    const endDy = previous.y - end.y;
    const endLength = Math.max(1, Math.hypot(endDx, endDy));
    const endLabelX = end.x + (endDx / endLength) * 28 + (-endDy / endLength) * 11;
    const endLabelY = end.y + (endDy / endLength) * 28 + (endDx / endLength) * 11;

    const fromToken = toRelationToken(route.fromCardinality);
    const toToken = toRelationToken(route.toCardinality);
    const relationRatio = `${toToken}-${fromToken}`;

    context.font = "700 14px Menlo, Monaco, Consolas, 'Courier New', monospace";
    context.fillStyle = "#6caea0";
    context.fillText(fromToken, startLabelX, startLabelY);
    context.fillText(toToken, endLabelX, endLabelY);

    context.font = "600 16px Iowan Old Style, Palatino Linotype, Palatino, Garamond, serif";
    const relationLabel = fitText(context, route.label, 128);
    const relationTextWidth = context.measureText(relationLabel).width;
    const diamondWidth = Math.min(164, Math.max(112, relationTextWidth + 44));
    const diamondHeight = 64;
    const cx = route.diamond.x;
    const cy = route.diamond.y;

    context.beginPath();
    context.moveTo(cx, cy - diamondHeight / 2);
    context.lineTo(cx + diamondWidth / 2, cy);
    context.lineTo(cx, cy + diamondHeight / 2);
    context.lineTo(cx - diamondWidth / 2, cy);
    context.closePath();
    context.fillStyle = "#f7f7f7";
    context.fill();
    context.strokeStyle = "#111111";
    context.lineWidth = 1.9;
    context.stroke();

    context.font = "600 14px Iowan Old Style, Palatino Linotype, Palatino, Garamond, serif";
    context.fillStyle = "#111111";
    context.fillText(relationLabel, cx, cy - 7);

    context.font = "700 13px Menlo, Monaco, Consolas, 'Courier New', monospace";
    context.fillStyle = "#111111";
    context.fillText(relationRatio, cx, cy + 12);
  }

  for (const positionedEntity of layout.entities) {
    for (const attribute of positionedEntity.attributes) {
      const isLeft = attribute.x < positionedEntity.centerX;
      const lineStartX = isLeft
        ? positionedEntity.x
        : positionedEntity.x + positionedEntity.width;
      const lineStartY = positionedEntity.centerY;
      const lineEndX = isLeft ? attribute.x + attribute.rx : attribute.x - attribute.rx;

      context.beginPath();
      context.moveTo(lineStartX, lineStartY);
      context.lineTo(lineEndX, attribute.y);
      context.strokeStyle = "#111111";
      context.lineWidth = 1.5;
      context.stroke();

      context.beginPath();
      context.ellipse(attribute.x, attribute.y, attribute.rx, attribute.ry, 0, 0, Math.PI * 2);
      context.fillStyle = "#fdfdfd";
      context.fill();
      if (attribute.attribute.isDerived) {
        context.setLineDash([6, 4]);
      }
      context.strokeStyle = "#111111";
      context.lineWidth = 1.5;
      context.stroke();
      context.setLineDash([]);

      if (attribute.attribute.isMultivalued) {
        context.beginPath();
        context.ellipse(
          attribute.x,
          attribute.y,
          attribute.rx + 5,
          attribute.ry + 4,
          0,
          0,
          Math.PI * 2,
        );
        context.strokeStyle = "#111111";
        context.lineWidth = 1.1;
        context.stroke();
      }

      context.font = "500 11px Menlo, Monaco, Consolas, 'Courier New', monospace";
      context.fillStyle = "#111111";
      const maxLabelWidth = attribute.rx * 1.75;
      const trimmedLabel = fitText(context, attribute.label, maxLabelWidth);
      context.fillText(trimmedLabel, attribute.x, attribute.y + 1);

      if (attribute.attribute.isPrimary) {
        const textWidth = context.measureText(trimmedLabel).width;
        context.beginPath();
        context.moveTo(attribute.x - textWidth / 2, attribute.y + 5);
        context.lineTo(attribute.x + textWidth / 2, attribute.y + 5);
        context.strokeStyle = "#111111";
        context.lineWidth = 1.1;
        context.stroke();
      }
    }

    if (positionedEntity.entity.isWeak) {
      drawRoundedRect(
        context,
        positionedEntity.x - 7,
        positionedEntity.y - 7,
        positionedEntity.width + 14,
        positionedEntity.height + 14,
        11,
      );
      context.strokeStyle = "#111111";
      context.lineWidth = 2;
      context.stroke();
    }

    drawRoundedRect(
      context,
      positionedEntity.x,
      positionedEntity.y,
      positionedEntity.width,
      positionedEntity.height,
      10,
    );
    context.fillStyle = "#fdfdfd";
    context.fill();
    context.strokeStyle = "#111111";
    context.lineWidth = 1.8;
    context.stroke();

    context.font = "700 25px Iowan Old Style, Palatino Linotype, Palatino, Garamond, serif";
    context.fillStyle = "#111111";
    context.fillText(
      getShortName(positionedEntity.entity.name),
      positionedEntity.centerX,
      positionedEntity.centerY + 1,
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
      (value) => {
        if (value) {
          resolve(value);
        } else {
          reject(new Error("Image export failed."));
        }
      },
      mimeType,
      format === "jpg" ? 0.95 : undefined,
    );
  });

  triggerBlobDownload(blob, `erd-diagram-${timestamp}.${format}`);
}

function fallbackDiagram(): DiagramModel {
  try {
    return parseSqlSchema(SAMPLE_SQL);
  } catch {
    return { entities: [], relationships: [] };
  }
}

export default function Home() {
  const [schemaInput, setSchemaInput] = useState(SAMPLE_SQL);
  const [diagram, setDiagram] = useState<DiagramModel>(() => fallbackDiagram());
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
  const [layoutSeed, setLayoutSeed] = useState(() => hashTextToSeed(SAMPLE_SQL));

  const panPointerRef = useRef<Point | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const layout = useMemo(
    () => buildDiagramLayout(diagram, layoutSeed),
    [diagram, layoutSeed],
  );

  useEffect(() => {
    const updateViewport = (): void => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };

    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => {
      window.removeEventListener("resize", updateViewport);
    };
  }, []);

  useEffect(() => {
    if (viewport.width === 0 || viewport.height === 0) {
      return;
    }

    setViewTransform(getFittedTransform(layout, viewport.width, viewport.height));
  }, [layout, viewport.width, viewport.height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (
      !canvas ||
      viewport.width === 0 ||
      viewport.height === 0 ||
      !viewTransform.initialized
    ) {
      return;
    }

    const devicePixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * devicePixelRatio);
    canvas.height = Math.floor(viewport.height * devicePixelRatio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    drawCanvasDiagram(context, layout, viewport.width, viewport.height, viewTransform);
  }, [layout, viewport, viewTransform]);

  const zoomAtPoint = (zoomFactor: number, anchorX: number, anchorY: number): void => {
    setViewTransform((previous) => {
      const nextScale = clampScale(previous.scale * zoomFactor);
      const worldX = (anchorX - previous.offsetX) / previous.scale;
      const worldY = (anchorY - previous.offsetY) / previous.scale;

      return {
        ...previous,
        scale: nextScale,
        offsetX: anchorX - worldX * nextScale,
        offsetY: anchorY - worldY * nextScale,
      };
    });
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0 && event.button !== 1) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    panPointerRef.current = { x: event.clientX, y: event.clientY };
    setIsPanning(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!panPointerRef.current) {
      return;
    }

    const dx = event.clientX - panPointerRef.current.x;
    const dy = event.clientY - panPointerRef.current.y;
    panPointerRef.current = { x: event.clientX, y: event.clientY };

    setViewTransform((previous) => ({
      ...previous,
      offsetX: previous.offsetX + dx,
      offsetY: previous.offsetY + dy,
    }));
  };

  const endPan = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    panPointerRef.current = null;
    setIsPanning(false);
  };

  const handleWheel = (event: React.WheelEvent<HTMLCanvasElement>): void => {
    event.preventDefault();

    if (!canvasRef.current) {
      return;
    }

    const rect = canvasRef.current.getBoundingClientRect();
    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    const zoomFactor = Math.exp(-event.deltaY * 0.00135);

    zoomAtPoint(zoomFactor, anchorX, anchorY);
  };

  const handleZoomIn = (): void => {
    zoomAtPoint(1.14, viewport.width / 2, viewport.height / 2);
  };

  const handleZoomOut = (): void => {
    zoomAtPoint(1 / 1.14, viewport.width / 2, viewport.height / 2);
  };

  const handleResetView = (): void => {
    if (viewport.width === 0 || viewport.height === 0) {
      return;
    }

    setViewTransform(getFittedTransform(layout, viewport.width, viewport.height));
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
    if (!canvasRef.current || diagram.entities.length === 0) {
      return;
    }

    setIsExporting(true);
    setErrorMessage("");
    try {
      await exportCanvasAsImage(canvasRef.current, exportFormat);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Failed to export the diagram. Please try again.",
      );
    } finally {
      setIsExporting(false);
    }
  };

  const zoomPercent = Math.round(viewTransform.scale * 100);

  return (
    <main className="fullscreen-shell">
      <canvas
        ref={canvasRef}
        className={`screen-canvas ${isPanning ? "panning" : ""}`}
        role="img"
        aria-label="Traditional ER diagram canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onWheel={handleWheel}
      />

      <div className="floating-title">Traditional ER Diagram Canvas</div>

      <header className="floating-toolbar">
        <div className="toolbar-group">
          <button
            type="button"
            className="ghost-btn"
            onClick={() => setIsSchemaOpen((current) => !current)}
          >
            {isSchemaOpen ? "Hide SQL" : "Show SQL"}
          </button>
          <button type="button" className="ghost-btn" onClick={handleLoadBankExample}>
            Load Bank Example
          </button>
          <button type="button" className="primary-btn" onClick={handleGenerate}>
            Generate Diagram
          </button>
        </div>

        <div className="toolbar-group">
          <button type="button" className="icon-btn" onClick={handleZoomOut}>
            -
          </button>
          <span className="zoom-pill">{zoomPercent}%</span>
          <button type="button" className="icon-btn" onClick={handleZoomIn}>
            +
          </button>
          <button type="button" className="ghost-btn" onClick={handleResetView}>
            Reset View
          </button>
        </div>

        <div className="toolbar-group">
          <select
            aria-label="Export format"
            value={exportFormat}
            onChange={(event) => setExportFormat(event.target.value as ExportFormat)}
          >
            <option value="png">PNG</option>
            <option value="jpg">JPG</option>
          </select>
          <button
            type="button"
            className="primary-btn"
            onClick={handleDownload}
            disabled={diagram.entities.length === 0 || isExporting}
          >
            {isExporting ? "Exporting..." : "Download"}
          </button>
        </div>
      </header>

      <div className="interaction-hint">Drag to pan • Scroll to zoom</div>

      {errorMessage ? <div className="floating-error">{errorMessage}</div> : null}

      <aside className={`sql-panel ${isSchemaOpen ? "open" : "closed"}`}>
        <header className="sql-panel-header">
          <h2>SQL Schema</h2>
          <button
            type="button"
            className="ghost-btn compact"
            onClick={() => setIsSchemaOpen(false)}
          >
            Close
          </button>
        </header>

        <textarea
          aria-label="SQL schema input"
          className="schema-editor"
          value={schemaInput}
          onChange={(event) => setSchemaInput(event.target.value)}
          spellCheck={false}
        />

        <p className="hint">
          Supported best with <code>CREATE TABLE</code>, <code>PRIMARY KEY</code>,{" "}
          <code>FOREIGN KEY</code>, and inline <code>REFERENCES</code>. Add NOT NULL
          and UNIQUE on FK columns for stronger cardinality inference.
        </p>

        <div className="panel-stats">
          <span>{diagram.entities.length} tables</span>
          <span>{diagram.relationships.length} relationships</span>
        </div>

        <div className="panel-legend">
          <span>Rectangle: entity</span>
          <span>Diamond: relationship</span>
          <span>Oval: attribute</span>
          <span>Underlined: primary key</span>
          <span>Double oval: multivalued</span>
          <span>Dashed oval: derived</span>
          <span>Double rectangle: weak entity</span>
          <span>Double line: total participation</span>
          <span>Cardinality: 1 or N at each end</span>
          <span>Relationship ratio: 1-N / N-1 below diamonds</span>
        </div>

        <div className="panel-guide">
          <strong>ERD Steps</strong>
          <ol>
            <li>Identify entities from your schema.</li>
            <li>Review attributes and PK highlights.</li>
            <li>Check relationship diamonds and connectors.</li>
            <li>Verify cardinality labels on both relationship sides.</li>
            <li>Confirm total participation (double lines) where required.</li>
            <li>Reposition using pan/zoom for clean readability.</li>
          </ol>
        </div>
      </aside>
    </main>
  );
}
