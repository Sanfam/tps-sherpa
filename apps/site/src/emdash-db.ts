import { CompiledQuery, type DatabaseConnection, type Dialect, type Driver, type AbortableOperationOptions } from "kysely";
import { MIGRATION_NAMES } from "emdash/db";
import { createDialect as createSqliteDialect } from "emdash/db/sqlite";

type SqliteConfig = { url: string };

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function execute(connection: DatabaseConnection, statement: string) {
  await connection.executeQuery(CompiledQuery.raw(statement));
}

async function migrationNames(connection: DatabaseConnection): Promise<Set<string> | null> {
  try {
    // EmDash internal `_emdash_migrations` is the runtime's applied-migration ledger.
    const result = await connection.executeQuery<{ name: string }>(
      CompiledQuery.raw("SELECT name FROM _emdash_migrations"),
    );
    return new Set(result.rows.map((row) => row.name));
  } catch {
    return null;
  }
}

async function ftsTables(connection: DatabaseConnection): Promise<Set<string>> {
  // EmDash's internal FTS5 tables are discovered through sqlite_master so a renamed collection is covered.
  const result = await connection.executeQuery<{ name: string }>(
    CompiledQuery.raw(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL AND lower(sql) LIKE '%using fts5%'",
    ),
  );
  return new Set(result.rows.map((row) => row.name));
}

async function secureFtsDeletes(connection: DatabaseConnection, names: Set<string>) {
  for (const name of names) {
    await execute(
      connection,
      `INSERT INTO ${quote(name)}(${quote(name)}, rank) VALUES ('secure-delete', 1)`,
    );
  }
  return names;
}

// ponytail: every acquire and release reads the migration ledger and, once
// migrations are done, sqlite_master, so a CMS request makes a few extra local
// queries. Cache "migrations complete" if that ever shows in latency.
class SecureDeleteDriver implements Driver {
  private readonly base: Driver;
  private beforeMigrations: Set<string> | null = null;
  private maintained = false;
  private ftsNames = new Set<string>();

  constructor(base: Driver) {
    this.base = base;
  }

  async init(options?: AbortableOperationOptions) {
    await this.base.init(options);
    const connection = await this.base.acquireConnection(options);
    try {
      await execute(connection, "PRAGMA secure_delete = ON");
      this.beforeMigrations = await migrationNames(connection);
    } finally {
      await this.base.releaseConnection(connection, options);
    }
  }

  async acquireConnection(options?: AbortableOperationOptions) {
    const connection = await this.base.acquireConnection(options);
    // EmDash's public SQLite dialect currently has one Node connection; keep this on acquire so a future pool is covered too.
    await execute(connection, "PRAGMA secure_delete = ON");
    try {
      const applied = await migrationNames(connection);
      if (applied && MIGRATION_NAMES.every((name) => applied.has(name))) {
        const names = await ftsTables(connection);
        if (![...names].every((name) => this.ftsNames.has(name))) {
          await secureFtsDeletes(connection, names);
          this.ftsNames = names;
        }
      }
    } catch (error) {
      console.error("[emdash] FTS erasure maintenance failed:", error);
    }
    return connection;
  }

  async releaseConnection(connection: DatabaseConnection, options?: AbortableOperationOptions) {
    try {
      const applied = await migrationNames(connection);
      const complete = applied && MIGRATION_NAMES.every((name) => applied.has(name));
      if (complete) {
        try {
          const names = await ftsTables(connection);
          if (![...names].every((name) => this.ftsNames.has(name))) {
            await secureFtsDeletes(connection, names);
            this.ftsNames = names;
          }
        } catch (error) {
          console.error("[emdash] FTS erasure maintenance failed:", error);
        }
        if (!this.maintained) {
          try {
            if (!this.beforeMigrations || MIGRATION_NAMES.some((name) => !this.beforeMigrations?.has(name))) {
              // EmDash migrations can copy-and-drop content tables; VACUUM scrubs their freed pages.
              await execute(connection, "VACUUM");
            }
            this.maintained = true;
          } catch (error) {
            console.error("[emdash] SQLite VACUUM maintenance failed:", error);
          }
        }
      }
    } catch (error) {
      console.error("[emdash] SQLite erasure maintenance failed:", error);
    } finally {
      await this.base.releaseConnection(connection, options);
    }
  }

  beginTransaction(connection: DatabaseConnection, settings: Parameters<Driver["beginTransaction"]>[1]) {
    return this.base.beginTransaction(connection, settings);
  }

  commitTransaction(connection: DatabaseConnection) {
    return this.base.commitTransaction(connection);
  }

  rollbackTransaction(connection: DatabaseConnection) {
    return this.base.rollbackTransaction(connection);
  }

  savepoint(...args: Parameters<NonNullable<Driver["savepoint"]>>) {
    return this.base.savepoint!(...args);
  }

  rollbackToSavepoint(...args: Parameters<NonNullable<Driver["rollbackToSavepoint"]>>) {
    return this.base.rollbackToSavepoint!(...args);
  }

  releaseSavepoint(...args: Parameters<NonNullable<Driver["releaseSavepoint"]>>) {
    return this.base.releaseSavepoint!(...args);
  }

  destroy(options?: AbortableOperationOptions) {
    return this.base.destroy(options);
  }
}

/** The descriptor's runtime entrypoint: EmDash's public SQLite dialect plus our connection hygiene. */
export function createDialect(config: SqliteConfig): Dialect {
  const dialect = createSqliteDialect(config);
  return {
    createDriver: () => new SecureDeleteDriver(dialect.createDriver()),
    createQueryCompiler: () => dialect.createQueryCompiler(),
    createAdapter: () => dialect.createAdapter(),
    createIntrospector: (db) => dialect.createIntrospector(db),
  };
}
