export type DbRow = Record<string, unknown>;
// The legacy Supabase client was effectively untyped across this codebase.
// Keep row values permissive at this compatibility boundary and rely on route
// validation/access checks for behavior.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = any;

export interface SqlExecutor {
  rawQueryAll<T extends DbRow = DbRow>(
    sql: string,
    ...params: unknown[]
  ): Promise<T[]>;
  rawQueryRow<T extends DbRow = DbRow>(
    sql: string,
    ...params: unknown[]
  ): Promise<T | null>;
  rawExec(sql: string, ...params: unknown[]): Promise<void>;
}

export type QueryResponse<T> = {
  data: T | null;
  error: Error | null;
  count?: number | null;
};

type SelectOptions = {
  count?: "exact";
  head?: boolean;
};

type OrderOptions = {
  ascending?: boolean;
  nullsFirst?: boolean;
};

type UpsertOptions = {
  onConflict?: string;
  ignoreDuplicates?: boolean;
};

type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "neq"; column: string; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "is"; column: string; value: null }
  | { kind: "not"; column: string; operator: string; value: unknown }
  | { kind: "contains"; column: string; value: unknown };

type OrFilter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "in"; column: string; values: unknown[] };

type Action = "select" | "insert" | "update" | "delete" | "upsert";

function quoteIdent(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function errorResponse<T>(err: unknown): QueryResponse<T> {
  return {
    data: null,
    error: err instanceof Error ? err : new Error(String(err)),
  };
}

function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(depth - 1, 0);
    else if (char === separator && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parseOrFilterPart(part: string): OrFilter {
  const eqMatch = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\.eq\.(.*)$/);
  if (eqMatch) {
    return { kind: "eq", column: eqMatch[1], value: eqMatch[2] };
  }

  const inMatch = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\.in\.\((.*)\)$/);
  if (inMatch) {
    const values = inMatch[2]
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    return { kind: "in", column: inMatch[1], values };
  }

  throw new Error(`Unsupported OR filter: ${part}`);
}

function appendParam(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

function buildFilterSql(filter: Filter, params: unknown[]): string {
  if (filter.kind === "eq") {
    return `${quoteIdent(filter.column)} = ${appendParam(params, filter.value)}`;
  }
  if (filter.kind === "neq") {
    return `${quoteIdent(filter.column)} <> ${appendParam(params, filter.value)}`;
  }
  if (filter.kind === "in") {
    if (filter.values.length === 0) return "false";
    const placeholders = filter.values.map((v) => appendParam(params, v));
    return `${quoteIdent(filter.column)} IN (${placeholders.join(", ")})`;
  }
  if (filter.kind === "is") {
    return `${quoteIdent(filter.column)} IS NULL`;
  }
  if (filter.kind === "not") {
    if (filter.operator === "is" && filter.value === null) {
      return `${quoteIdent(filter.column)} IS NOT NULL`;
    }
    throw new Error(`Unsupported NOT filter: ${filter.operator}`);
  }
  return `${quoteIdent(filter.column)} @> ${appendParam(params, filter.value)}::jsonb`;
}

function buildOrFilterSql(filter: OrFilter, params: unknown[]): string {
  if (filter.kind === "eq") {
    return `${quoteIdent(filter.column)} = ${appendParam(params, filter.value)}`;
  }
  if (filter.values.length === 0) return "false";
  const placeholders = filter.values.map((v) => appendParam(params, v));
  return `${quoteIdent(filter.column)} IN (${placeholders.join(", ")})`;
}

function columnsFromRows(rows: DbRow[]): string[] {
  const columns = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) columns.add(key);
  }
  return [...columns];
}

class PostgresQueryBuilder
  implements PromiseLike<QueryResponse<AnyRow[]>>
{
  private action: Action = "select";
  private selectColumns = "*";
  private selectOptions: SelectOptions | undefined;
  private filters: Filter[] = [];
  private orFilters: OrFilter[][] = [];
  private orderBy: { column: string; options: OrderOptions }[] = [];
  private limitCount: number | null = null;
  private singleMode: "single" | "maybeSingle" | null = null;
  private insertRows: DbRow[] = [];
  private updateValues: DbRow | null = null;
  private upsertOptions: UpsertOptions | null = null;
  private returningColumns: string | null = null;

  constructor(
    private readonly executor: SqlExecutor,
    private readonly table: string,
  ) {}

  select(columns = "*", options?: SelectOptions): this {
    const sanitized = this.sanitizeSelectColumns(columns);
    if (this.action === "insert" || this.action === "update" || this.action === "upsert") {
      this.returningColumns = sanitized;
    } else {
      this.action = "select";
      this.selectColumns = sanitized;
      this.selectOptions = options;
    }
    return this;
  }

  private sanitizeSelectColumns(columns: string): string {
    if (columns.trim() === "*") return "*";
    const tokens = columns.split(",").map((token) => token.trim());
    const validated: string[] = [];
    for (const token of tokens) {
      if (token === "*") {
        validated.push("*");
      } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) {
        validated.push(quoteIdent(token));
      } else {
        throw new Error(`Invalid column identifier: ${token}`);
      }
    }
    return validated.join(", ");
  }

  insert(values: DbRow | DbRow[]): this {
    this.action = "insert";
    this.insertRows = Array.isArray(values) ? values : [values];
    return this;
  }

  update(values: DbRow): this {
    this.action = "update";
    this.updateValues = values;
    return this;
  }

  delete(): this {
    this.action = "delete";
    return this;
  }

  upsert(values: DbRow | DbRow[], options?: UpsertOptions): this {
    this.action = "upsert";
    this.insertRows = Array.isArray(values) ? values : [values];
    this.upsertOptions = options ?? {};
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push({ kind: "neq", column, value });
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push({ kind: "in", column, values });
    return this;
  }

  is(column: string, value: null): this {
    this.filters.push({ kind: "is", column, value });
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    this.filters.push({ kind: "not", column, operator, value });
    return this;
  }

  filter(column: string, operator: string, value: unknown): this {
    if (operator !== "cs") {
      throw new Error(`Unsupported filter operator: ${operator}`);
    }
    this.filters.push({ kind: "contains", column, value });
    return this;
  }

  or(filter: string): this {
    this.orFilters.push(splitTopLevel(filter, ",").map(parseOrFilterPart));
    return this;
  }

  order(column: string, options: OrderOptions = {}): this {
    this.orderBy.push({ column, options });
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  single(): Promise<QueryResponse<AnyRow>> {
    this.singleMode = "single";
    return this.executeSingle();
  }

  maybeSingle(): Promise<QueryResponse<AnyRow>> {
    this.singleMode = "maybeSingle";
    return this.executeSingle();
  }

  then<TResult1 = QueryResponse<AnyRow[]>, TResult2 = never>(
    onfulfilled?:
      | ((value: QueryResponse<AnyRow[]>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.executeMany().then(onfulfilled, onrejected);
  }

  private whereClause(params: unknown[]): string {
    const parts = this.filters.map((filter) => buildFilterSql(filter, params));
    for (const group of this.orFilters) {
      parts.push(
        `(${group.map((filter) => buildOrFilterSql(filter, params)).join(" OR ")})`,
      );
    }
    return parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
  }

  private orderClause(): string {
    if (this.orderBy.length === 0) return "";
    const parts = this.orderBy.map(({ column, options }) => {
      const direction = options.ascending === false ? "DESC" : "ASC";
      const nulls =
        options.nullsFirst === undefined
          ? ""
          : options.nullsFirst
            ? " NULLS FIRST"
            : " NULLS LAST";
      return `${quoteIdent(column)} ${direction}${nulls}`;
    });
    return ` ORDER BY ${parts.join(", ")}`;
  }

  private limitClause(): string {
    return this.limitCount ? ` LIMIT ${this.limitCount}` : "";
  }

  private async executeMany(): Promise<QueryResponse<AnyRow[]>> {
    this.singleMode = null;
    return this.execute() as Promise<QueryResponse<AnyRow[]>>;
  }

  private async executeSingle(): Promise<QueryResponse<AnyRow>> {
    return this.execute() as Promise<QueryResponse<AnyRow>>;
  }

  private async execute(): Promise<QueryResponse<AnyRow | AnyRow[]>> {
    try {
      if (this.action === "select") return await this.executeSelect();
      if (this.action === "insert") return await this.executeInsert();
      if (this.action === "update") return await this.executeUpdate();
      if (this.action === "delete") return await this.executeDelete();
      return await this.executeUpsert();
    } catch (err) {
      return errorResponse(err);
    }
  }

  private async executeSelect(): Promise<QueryResponse<AnyRow | AnyRow[]>> {
    const params: unknown[] = [];
    if (this.selectOptions?.count === "exact" && this.selectOptions.head) {
      const sql = `SELECT count(*)::int AS count FROM ${quoteIdent(this.table)}${this.whereClause(params)}`;
      const row = await this.executor.rawQueryRow<{ count: number }>(sql, ...params);
      return {
        data: null,
        error: null,
        count: typeof row?.count === "number" ? row.count : 0,
      };
    }

    const sql = `SELECT ${this.selectColumns} FROM ${quoteIdent(this.table)}${this.whereClause(params)}${this.orderClause()}${this.limitClause()}`;
    const rows = await this.executor.rawQueryAll<DbRow>(sql, ...params);
    return this.formatRows(rows);
  }

  private async executeInsert(): Promise<QueryResponse<AnyRow | AnyRow[]>> {
    const { sql, params } = this.insertSql();
    if (this.returningColumns) {
      const rows = await this.executor.rawQueryAll<DbRow>(
        `${sql} RETURNING ${this.returningColumns}`,
        ...params,
      );
      return this.formatRows(rows);
    }
    await this.executor.rawExec(sql, ...params);
    return { data: null, error: null };
  }

  private async executeUpdate(): Promise<QueryResponse<AnyRow | AnyRow[]>> {
    if (!this.updateValues) throw new Error("update values are required");
    const entries = Object.entries(this.updateValues);
    if (entries.length === 0) throw new Error("update values are required");
    const params: unknown[] = [];
    const setSql = entries.map(
      ([column, value]) => `${quoteIdent(column)} = ${appendParam(params, value)}`,
    );
    const sql = `UPDATE ${quoteIdent(this.table)} SET ${setSql.join(", ")}${this.whereClause(params)}`;
    if (this.returningColumns) {
      const rows = await this.executor.rawQueryAll<DbRow>(
        `${sql} RETURNING ${this.returningColumns}`,
        ...params,
      );
      return this.formatRows(rows);
    }
    await this.executor.rawExec(sql, ...params);
    return { data: null, error: null };
  }

  private async executeDelete(): Promise<QueryResponse<AnyRow | AnyRow[]>> {
    const params: unknown[] = [];
    const sql = `DELETE FROM ${quoteIdent(this.table)}${this.whereClause(params)}`;
    await this.executor.rawExec(sql, ...params);
    return { data: null, error: null };
  }

  private async executeUpsert(): Promise<QueryResponse<AnyRow | AnyRow[]>> {
    const { sql, params, columns } = this.insertSql();
    const conflictColumns =
      this.upsertOptions?.onConflict
        ?.split(",")
        .map((column) => column.trim())
        .filter(Boolean) ?? [];
    if (conflictColumns.length === 0) {
      throw new Error("upsert requires onConflict");
    }
    const conflictSql = conflictColumns.map(quoteIdent).join(", ");
    let onConflict = ` ON CONFLICT (${conflictSql})`;
    if (this.upsertOptions?.ignoreDuplicates) {
      onConflict += " DO NOTHING";
    } else {
      const updateColumns = columns.filter(
        (column) => !conflictColumns.includes(column),
      );
      if (updateColumns.length === 0) {
        onConflict += " DO NOTHING";
      } else {
        onConflict += ` DO UPDATE SET ${updateColumns
          .map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`)
          .join(", ")}`;
      }
    }
    const fullSql = `${sql}${onConflict}`;
    if (this.returningColumns) {
      const rows = await this.executor.rawQueryAll<DbRow>(
        `${fullSql} RETURNING ${this.returningColumns}`,
        ...params,
      );
      return this.formatRows(rows);
    }
    await this.executor.rawExec(fullSql, ...params);
    return { data: null, error: null };
  }

  private insertSql(): { sql: string; params: unknown[]; columns: string[] } {
    if (this.insertRows.length === 0) throw new Error("insert rows are required");
    const columns = columnsFromRows(this.insertRows);
    if (columns.length === 0) throw new Error("insert rows are required");
    const params: unknown[] = [];
    const valuesSql = this.insertRows.map((row) => {
      const placeholders = columns.map((column) =>
        appendParam(params, row[column] ?? null),
      );
      return `(${placeholders.join(", ")})`;
    });
    return {
      columns,
      params,
      sql: `INSERT INTO ${quoteIdent(this.table)} (${columns
        .map(quoteIdent)
        .join(", ")}) VALUES ${valuesSql.join(", ")}`,
    };
  }

  private formatRows(rows: DbRow[]): QueryResponse<AnyRow | AnyRow[]> {
    if (this.singleMode) {
      const row = (rows[0] as AnyRow | undefined) ?? null;
      if (!row && this.singleMode === "single") {
        return { data: null, error: new Error("Row not found") };
      }
      return { data: row, error: null };
    }
    return { data: rows as AnyRow[], error: null };
  }
}

export class PostgresSupabaseCompatClient {
  public readonly auth: {
    admin: {
      listUsers: (options?: { perPage?: number }) => Promise<{
        data: { users: { id: string; email: string }[] };
        error: Error | null;
      }>;
      getUserById: (id: string) => Promise<{
        data: { user: { id: string; email: string } | null };
        error: Error | null;
      }>;
      deleteUser: (id: string) => Promise<{
        data: null;
        error: Error | null;
      }>;
    };
  };

  constructor(private readonly executor: SqlExecutor) {
    this.auth = {
      admin: {
        listUsers: async (options) => {
          try {
            const limit = Math.min(Math.max(options?.perPage ?? 1000, 1), 1000);
            const rows = await this.executor.rawQueryAll<{
              id: string;
              email: string;
            }>(
              'SELECT id, email FROM "users" ORDER BY "created_at" ASC LIMIT $1',
              limit,
            );
            return { data: { users: rows }, error: null };
          } catch (err) {
            return {
              data: { users: [] },
              error: err instanceof Error ? err : new Error(String(err)),
            };
          }
        },
        getUserById: async (id) => {
          try {
            const user = await this.executor.rawQueryRow<{
              id: string;
              email: string;
            }>('SELECT id, email FROM "users" WHERE "id" = $1', id);
            return { data: { user }, error: null };
          } catch (err) {
            return {
              data: { user: null },
              error: err instanceof Error ? err : new Error(String(err)),
            };
          }
        },
        deleteUser: async (id) => {
          try {
            await this.executor.rawExec('DELETE FROM "users" WHERE "id" = $1', id);
            return { data: null, error: null };
          } catch (err) {
            return errorResponse(err);
          }
        },
      },
    };
  }

  from(table: string): PostgresQueryBuilder {
    return new PostgresQueryBuilder(this.executor, table);
  }
}

export function createPostgresClient(
  executor: SqlExecutor,
): PostgresSupabaseCompatClient {
  return new PostgresSupabaseCompatClient(executor);
}
