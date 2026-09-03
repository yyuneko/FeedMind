import type { D1Database, D1PreparedStatement } from "./cloudflare";

export const REQUEST_OWNER = "__feedmind_request_owner__";

/** Replaces the internal owner sentinel at the binding boundary, keeping request ownership concurrency-safe. */
export function scopedDatabase(database: D1Database, ownerId: string): D1Database {
  const underlying = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped: D1PreparedStatement = {
      bind(...values: unknown[]) { return wrap(statement.bind(...values.map((value) => value === REQUEST_OWNER ? ownerId : value))); },
      first: <T>() => statement.first<T>(),
      all: <T>() => statement.all<T>(),
      run: <T>() => statement.run<T>(),
    };
    underlying.set(wrapped, statement);
    return wrapped;
  };
  return {
    prepare(query: string) { return wrap(database.prepare(query)); },
    batch(statements) { return database.batch(statements.map((statement) => underlying.get(statement as object) ?? statement)); },
  };
}
