import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';

export const LEGACY_1X_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  snapshot TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  `CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  behavior TEXT NOT NULL,
  reason TEXT,
  at INTEGER NOT NULL
)`,
  'CREATE INDEX audit_session_id_idx ON audit (session_id)',
  `CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  created_at INTEGER NOT NULL,
  run_id TEXT,
  label TEXT,
  summary TEXT,
  snapshot TEXT NOT NULL,
  file_changes TEXT
)`,
  'CREATE INDEX checkpoints_session_id_idx ON checkpoints (session_id)',
  'CREATE INDEX checkpoints_parent_checkpoint_id_idx ON checkpoints (parent_checkpoint_id)',
  `CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  'CREATE UNIQUE INDEX projects_path_idx ON projects (path)',
  `CREATE TABLE session_metadata (
  session_id TEXT PRIMARY KEY,
  project_id TEXT,
  pinned INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  'CREATE INDEX session_metadata_project_id_idx ON session_metadata (project_id)',
  `CREATE TABLE installed_plugins (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  registry_name TEXT NOT NULL,
  title TEXT,
  description TEXT,
  version TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  config TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
]);

export const LEGACY_1X_SCHEMA_SOURCE = `${LEGACY_1X_SCHEMA_STATEMENTS.map(
  (statement) => `${statement};`,
).join('\n')}\n`;

export type LegacySchemaColumn = Readonly<{
  cid: number;
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKeyPosition: number;
  hidden: number;
}>;

export type LegacySchemaForeignKey = Readonly<{
  id: number;
  sequence: number;
  table: string;
  from: string;
  to: string | null;
  onUpdate: string;
  onDelete: string;
  match: string;
}>;

export type LegacySchemaIndexColumn = Readonly<{
  sequence: number;
  cid: number;
  name: string | null;
  descending: boolean;
  collation: string;
  key: boolean;
}>;

export type LegacySchemaIndex = Readonly<{
  name: string;
  unique: boolean;
  origin: string;
  partial: boolean;
  sql: string | null;
  columns: readonly LegacySchemaIndexColumn[];
}>;

export type LegacySchemaTable = Readonly<{
  name: string;
  sql: string;
  columns: readonly LegacySchemaColumn[];
  foreignKeys: readonly LegacySchemaForeignKey[];
  indexes: readonly LegacySchemaIndex[];
}>;

export type LegacySchemaSqlObject = Readonly<{
  name: string;
  table: string;
  sql: string;
}>;

export type LegacySchemaManifest = Readonly<{
  formatVersion: 1;
  userVersion: number;
  sqliteInternals: Readonly<{ sequenceTable: boolean }>;
  tables: readonly LegacySchemaTable[];
  triggers: readonly LegacySchemaSqlObject[];
  views: readonly LegacySchemaSqlObject[];
}>;

export class LegacySchemaInspectionError extends Error {
  readonly code = 'schema_inspection_failed' as const;

  constructor() {
    super('SQLite schema could not be inspected safely');
    this.name = 'LegacySchemaInspectionError';
  }
}

type UnknownRow = Record<string, unknown>;

function inspectionFailure(): never {
  throw new LegacySchemaInspectionError();
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value)) inspectionFailure();
  return value as number;
}

function nonNegativeInteger(value: unknown): number {
  const result = safeInteger(value);
  if (result < 0) inspectionFailure();
  return result;
}

function booleanInteger(value: unknown): boolean {
  if (value !== 0 && value !== 1) inspectionFailure();
  return value === 1;
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string') inspectionFailure();
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return stringValue(value);
}

function readQuotedSqlToken(sql: string, start: number): number {
  const opener = sql[start]!;
  const closer = opener === '[' ? ']' : opener;
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] !== closer) {
      index += 1;
      continue;
    }
    if (closer !== ']' && sql[index + 1] === closer) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  inspectionFailure();
}

function canonicalizeStoredSql(sql: string): string {
  const tokens: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const character = sql[index]!;
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (sql.startsWith('--', index)) {
      const newline = sql.indexOf('\n', index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      const close = sql.indexOf('*/', index + 2);
      if (close === -1) inspectionFailure();
      index = close + 2;
      continue;
    }
    if (
      character === "'" ||
      character === '"' ||
      character === '`' ||
      character === '['
    ) {
      const end = readQuotedSqlToken(sql, index);
      tokens.push(sql.slice(index, end));
      index = end;
      continue;
    }
    if (/[A-Za-z0-9_$]/u.test(character)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/u.test(sql[end]!)) end += 1;
      tokens.push(sql.slice(index, end));
      index = end;
      continue;
    }
    const doubleOperator = sql.slice(index, index + 2);
    if (
      ['<=', '>=', '<>', '!=', '==', '||', '->', '<<', '>>'].includes(
        doubleOperator,
      )
    ) {
      tokens.push(doubleOperator);
      index += 2;
      continue;
    }
    tokens.push(character);
    index += 1;
  }
  while (tokens.at(-1) === ';') tokens.pop();
  if (tokens.length === 0) inspectionFailure();
  return `${tokens.join(' ')} ;`;
}

function normalizeStoredSql(value: unknown): string {
  const sql = stringValue(value).replaceAll('\r\n', '\n').trim();
  if (sql.length === 0) inspectionFailure();
  return canonicalizeStoredSql(sql);
}

function queryAll(
  database: Database,
  sql: string,
  ...parameters: string[]
): UnknownRow[] {
  let statement;
  let rows: UnknownRow[] | undefined;
  try {
    statement = database.prepare<UnknownRow, string[]>(sql);
    rows = statement.all(...parameters);
  } catch {
    // Converted to a path-safe inspection error after finalization.
  } finally {
    statement?.finalize();
  }
  if (rows === undefined) inspectionFailure();
  return rows;
}

function queryOne(
  database: Database,
  sql: string,
  ...parameters: string[]
): UnknownRow {
  let row: UnknownRow | null | undefined;
  let statement;
  try {
    statement = database.prepare<UnknownRow, string[]>(sql);
    row = statement.get(...parameters);
  } catch {
    // Converted to a path-safe inspection error after finalization.
  } finally {
    statement?.finalize();
  }
  if (row === null || row === undefined) inspectionFailure();
  return row;
}

function inspectColumns(
  database: Database,
  tableName: string,
): readonly LegacySchemaColumn[] {
  return Object.freeze(
    queryAll(
      database,
      `SELECT cid, name, type, "notnull" AS not_null,
              dflt_value, pk, hidden
       FROM pragma_table_xinfo(?) ORDER BY cid`,
      tableName,
    ).map((row) =>
      Object.freeze({
        cid: nonNegativeInteger(row.cid),
        name: stringValue(row.name),
        type: stringValue(row.type),
        notNull: booleanInteger(row.not_null),
        defaultValue: nullableString(row.dflt_value),
        primaryKeyPosition: nonNegativeInteger(row.pk),
        hidden: nonNegativeInteger(row.hidden),
      }),
    ),
  );
}

function inspectForeignKeys(
  database: Database,
  tableName: string,
): readonly LegacySchemaForeignKey[] {
  return Object.freeze(
    queryAll(
      database,
      `SELECT id, seq, "table" AS target_table, "from" AS source_column,
              "to" AS target_column, on_update, on_delete, "match" AS match_name
       FROM pragma_foreign_key_list(?) ORDER BY id, seq`,
      tableName,
    ).map((row) =>
      Object.freeze({
        id: nonNegativeInteger(row.id),
        sequence: nonNegativeInteger(row.seq),
        table: stringValue(row.target_table),
        from: stringValue(row.source_column),
        to: nullableString(row.target_column),
        onUpdate: stringValue(row.on_update),
        onDelete: stringValue(row.on_delete),
        match: stringValue(row.match_name),
      }),
    ),
  );
}

function inspectIndexColumns(
  database: Database,
  indexName: string,
): readonly LegacySchemaIndexColumn[] {
  return Object.freeze(
    queryAll(
      database,
      `SELECT seqno, cid, name, "desc" AS descending, coll, "key" AS is_key
       FROM pragma_index_xinfo(?) ORDER BY seqno`,
      indexName,
    ).map((row) =>
      Object.freeze({
        sequence: nonNegativeInteger(row.seqno),
        cid: safeInteger(row.cid),
        name: nullableString(row.name),
        descending: booleanInteger(row.descending),
        collation: stringValue(row.coll),
        key: booleanInteger(row.is_key),
      }),
    ),
  );
}

function inspectIndexes(
  database: Database,
  tableName: string,
): readonly LegacySchemaIndex[] {
  return Object.freeze(
    queryAll(
      database,
      `SELECT name, "unique" AS is_unique, origin, partial
       FROM pragma_index_list(?) ORDER BY name`,
      tableName,
    ).map((row) => {
      const name = stringValue(row.name);
      const sqlRow = queryOne(
        database,
        'SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?',
        'index',
        name,
      );
      return Object.freeze({
        name,
        unique: booleanInteger(row.is_unique),
        origin: stringValue(row.origin),
        partial: booleanInteger(row.partial),
        sql: sqlRow.sql === null ? null : normalizeStoredSql(sqlRow.sql),
        columns: inspectIndexColumns(database, name),
      });
    }),
  );
}

function inspectSqlObjects(
  database: Database,
  type: 'trigger' | 'view',
): readonly LegacySchemaSqlObject[] {
  return Object.freeze(
    queryAll(
      database,
      `SELECT name, tbl_name AS table_name, sql
       FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
      type,
    ).map((row) =>
      Object.freeze({
        name: stringValue(row.name),
        table: stringValue(row.table_name),
        sql: normalizeStoredSql(row.sql),
      }),
    ),
  );
}

export function inspectLegacySchema(database: Database): LegacySchemaManifest {
  const userVersionRow = queryOne(database, 'PRAGMA user_version');
  const userVersion = nonNegativeInteger(userVersionRow.user_version);
  const sequenceRow = queryOne(
    database,
    `SELECT count(*) AS count FROM sqlite_schema
     WHERE type = 'table' AND name = 'sqlite_sequence'`,
  );
  const sequenceCount = nonNegativeInteger(sequenceRow.count);
  if (sequenceCount > 1) inspectionFailure();

  const tables = Object.freeze(
    queryAll(
      database,
      `SELECT name, sql FROM sqlite_schema
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name <> 'schema_migrations'
       ORDER BY name`,
    ).map((row) => {
      const name = stringValue(row.name);
      return Object.freeze({
        name,
        sql: normalizeStoredSql(row.sql),
        columns: inspectColumns(database, name),
        foreignKeys: inspectForeignKeys(database, name),
        indexes: inspectIndexes(database, name),
      });
    }),
  );

  return Object.freeze({
    formatVersion: 1 as const,
    userVersion,
    sqliteInternals: Object.freeze({ sequenceTable: sequenceCount === 1 }),
    tables,
    triggers: inspectSqlObjects(database, 'trigger'),
    views: inspectSqlObjects(database, 'view'),
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function canonicalSchemaManifest(
  manifest: LegacySchemaManifest,
): string {
  return `${JSON.stringify(canonicalize(manifest), null, 2)}\n`;
}

export function legacySchemaChecksum(manifest: LegacySchemaManifest): string {
  return createHash('sha256')
    .update(canonicalSchemaManifest(manifest), 'utf8')
    .digest('hex');
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function canonicalSqliteValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number'
  ) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Object.freeze({ type: 'integer', value: value.toString() });
  }
  if (value instanceof Uint8Array) {
    return Object.freeze({
      type: 'blob',
      value: Buffer.from(value).toString('base64'),
    });
  }
  inspectionFailure();
}

export function legacyDataChecksum(
  database: Database,
  manifest = inspectLegacySchema(database),
): string {
  const hash = createHash('sha256');
  const updateField = (value: unknown): void => {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) inspectionFailure();
    hash.update(`${Buffer.byteLength(encoded, 'utf8')}:`, 'utf8');
    hash.update(encoded, 'utf8');
  };
  updateField(manifest.tables.length);
  for (const table of manifest.tables) {
    const columns = table.columns.map(({ name }) => name);
    const primaryKey = table.columns
      .filter(({ primaryKeyPosition }) => primaryKeyPosition > 0)
      .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition)
      .map(({ name }) => name);
    const order = primaryKey.length > 0 ? primaryKey : columns;
    const statement = database.prepare<Record<string, unknown>, []>(
      `SELECT ${columns.map(quoteIdentifier).join(', ')}
       FROM ${quoteIdentifier(table.name)}
       ORDER BY ${order.map(quoteIdentifier).join(', ')}`,
    );
    try {
      updateField(table.name);
      updateField(columns);
      for (const row of statement.iterate()) {
        updateField(columns.map((column) => canonicalSqliteValue(row[column])));
      }
      updateField('end-table');
    } catch {
      inspectionFailure();
    } finally {
      statement.finalize();
    }
  }
  return hash.digest('hex');
}

// Frozen after generating the manifest from the published 1.x DDL.
export const LEGACY_1X_SCHEMA_CHECKSUM =
  'aa421a21286862a79cc929e16f148b20f9afd486d512976a32ddd5a5dceb23d7';
