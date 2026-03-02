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
  fromCardinality: "o<" | "o|" | "||";
  toCardinality: "o|" | "||";
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

function buildDiagramLayout(model: DiagramModel): DiagramLayout {
  if (model.entities.length === 0) {
    return { width: 1600, height: 900, entities: [], relationshipPaths: [] };
  }

  const maxAttributes = Math.max(
    ...model.entities.map((entity) => Math.max(1, entity.attributes.length)),
  );
  const maxSideAttributes = Math.ceil(maxAttributes / 2);

  const entityWidth = 280;
  const entityHeight = 104;
  const maxOvalRadius = 188;
  const attributeToEntityGap = 124;
  const sideSpace = maxOvalRadius + attributeToEntityGap + 22;

  const cellWidth = Math.max(980, entityWidth + sideSpace * 2);
  const cellHeight = Math.max(620, maxSideAttributes * 86 + 280);
  const padding = 150;

  const cols = Math.max(1, Math.ceil(Math.sqrt(model.entities.length)));
  const rows = Math.ceil(model.entities.length / cols);

  const width = padding * 2 + cols * cellWidth;
  const height = padding * 2 + rows * cellHeight;

  const positionedEntities: PositionedEntity[] = model.entities.map(
    (entity, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const centerX = padding + col * cellWidth + cellWidth / 2;
      const centerY = padding + row * cellHeight + cellHeight / 2;
      const x = centerX - entityWidth / 2;
      const y = centerY - entityHeight / 2;

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

        const spacing = 86;
        const baseY = centerY - ((source.length - 1) * spacing) / 2;

        source.forEach((attribute, listIndex) => {
          const yPosition = baseY + listIndex * spacing;
          const label = createAttributeLabel(attribute);
          const rx = Math.max(82, Math.min(maxOvalRadius, 26 + label.length * 3.15));
          const xPosition =
            side === "left"
              ? x - attributeToEntityGap - rx
              : x + entityWidth + attributeToEntityGap + rx;

          attributes.push({
            attribute,
            x: xPosition,
            y: yPosition,
            rx,
            ry: 26,
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
        width: entityWidth,
        height: entityHeight,
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
    .map((relation, relationIndex) => {
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

      const laneOffset = ((relationIndex % 7) - 3) * 22;
      const horizontalDominant = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);

      const points: Point[] = [];
      let diamond: Point = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };

      if (horizontalDominant) {
        const midX = (start.x + end.x) / 2 + laneOffset;
        diamond = { x: midX, y: (start.y + end.y) / 2 };
        points.push(
          start,
          { x: midX, y: start.y },
          diamond,
          { x: midX, y: end.y },
          end,
        );
      } else {
        const midY = (start.y + end.y) / 2 + laneOffset;
        diamond = { x: (start.x + end.x) / 2, y: midY };
        points.push(
          start,
          { x: start.x, y: midY },
          diamond,
          { x: end.x, y: midY },
          end,
        );
      }

      const fkAttribute = fromEntity.attributes.find(
        (attribute) =>
          attribute.attribute.name.toLowerCase() === relation.fromColumn.toLowerCase(),
      )?.attribute;
      const fromCardinality: RelationshipPath["fromCardinality"] =
        fkAttribute?.isUnique || fkAttribute?.isPrimary ? "o|" : "o<";
      const toCardinality: RelationshipPath["toCardinality"] = fkAttribute?.isNullable
        ? "o|"
        : "||";
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
        label: `${relation.fromColumn} refs ${getShortName(relation.toTable)}`,
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

function drawCanvasDiagram(
  context: CanvasRenderingContext2D,
  layout: DiagramLayout,
  viewportWidth: number,
  viewportHeight: number,
  view: ViewTransform,
): void {
  context.clearRect(0, 0, viewportWidth, viewportHeight);

  const background = context.createLinearGradient(0, 0, viewportWidth, viewportHeight);
  background.addColorStop(0, "#0b1018");
  background.addColorStop(0.56, "#111a2a");
  background.addColorStop(1, "#09111a");
  context.fillStyle = background;
  context.fillRect(0, 0, viewportWidth, viewportHeight);

  context.save();
  context.strokeStyle = "rgba(141, 172, 214, 0.11)";
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
    context.fillStyle = "rgba(223, 236, 255, 0.9)";
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
  context.strokeStyle = "rgba(179, 213, 252, 0.18)";
  context.lineWidth = 1.2;
  context.stroke();

  context.strokeStyle = "#7bc3ff";
  context.lineWidth = 2.4;
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
    const startLabelX = start.x + (startDx / startLength) * 18 + (-startDy / startLength) * 10;
    const startLabelY = start.y + (startDy / startLength) * 18 + (startDx / startLength) * 10;

    const end = route.points[route.points.length - 1];
    const previous = route.points[route.points.length - 2];
    const endDx = previous.x - end.x;
    const endDy = previous.y - end.y;
    const endLength = Math.max(1, Math.hypot(endDx, endDy));
    const endLabelX = end.x + (endDx / endLength) * 18 + (-endDy / endLength) * 10;
    const endLabelY = end.y + (endDy / endLength) * 18 + (endDx / endLength) * 10;

    context.font = "700 12px Menlo, Monaco, Consolas, 'Courier New', monospace";
    context.fillStyle = "#d7e9ff";
    context.fillText(route.fromCardinality, startLabelX, startLabelY);
    context.fillText(route.toCardinality, endLabelX, endLabelY);

    const diamondSize = 14;
    context.save();
    context.translate(route.diamond.x, route.diamond.y);
    context.rotate(Math.PI / 4);
    context.beginPath();
    context.rect(-diamondSize / 2, -diamondSize / 2, diamondSize, diamondSize);
    context.fillStyle = "#0f1a2a";
    context.fill();
    context.strokeStyle = "#7bc3ff";
    context.lineWidth = 2;
    context.stroke();
    context.restore();

    context.font = "600 10px Menlo, Monaco, Consolas, 'Courier New', monospace";
    const visibleLabel = fitText(context, route.label, 74);
    context.fillStyle = "#dcecff";
    context.fillText(visibleLabel, route.diamond.x, route.diamond.y + 20);
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
      context.strokeStyle = "#8ea9cf";
      context.lineWidth = 1.7;
      context.stroke();

      context.beginPath();
      context.ellipse(attribute.x, attribute.y, attribute.rx, attribute.ry, 0, 0, Math.PI * 2);
      context.fillStyle = "#0e1725";
      context.fill();
      if (attribute.attribute.isDerived) {
        context.setLineDash([6, 4]);
      }
      context.strokeStyle = "#a2bddf";
      context.lineWidth = 1.8;
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
        context.strokeStyle = "#a2bddf";
        context.lineWidth = 1.2;
        context.stroke();
      }

      context.font = "500 11px Menlo, Monaco, Consolas, 'Courier New', monospace";
      context.fillStyle = "#deebff";
      const maxLabelWidth = attribute.rx * 1.75;
      const trimmedLabel = fitText(context, attribute.label, maxLabelWidth);
      context.fillText(trimmedLabel, attribute.x, attribute.y + 1);

      if (attribute.attribute.isPrimary) {
        const textWidth = context.measureText(trimmedLabel).width;
        context.beginPath();
        context.moveTo(attribute.x - textWidth / 2, attribute.y + 5);
        context.lineTo(attribute.x + textWidth / 2, attribute.y + 5);
        context.strokeStyle = "#deebff";
        context.lineWidth = 1.2;
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
      context.strokeStyle = "#d0e0f7";
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
    context.fillStyle = "#16263a";
    context.fill();
    context.strokeStyle = "#d0e0f7";
    context.lineWidth = 3;
    context.stroke();

    context.font = "700 25px Iowan Old Style, Palatino Linotype, Palatino, Garamond, serif";
    context.fillStyle = "#f2f7ff";
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

  const panPointerRef = useRef<Point | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const layout = useMemo(() => buildDiagramLayout(diagram), [diagram]);

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
    setErrorMessage("");
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
          <code>FOREIGN KEY</code>, and inline <code>REFERENCES</code>.
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
          <span>Crow's Foot: o&lt;, o|, ||</span>
        </div>
      </aside>
    </main>
  );
}
