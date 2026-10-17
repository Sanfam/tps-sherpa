/**
 * EmDash's own SQLite dialect, with `PRAGMA secure_delete = ON` run on each
 * connection before EmDash uses it (ADR-0001's erasure policy).
 *
 * Plugged in as a database descriptor: `{ ...sqlite({ url }), entrypoint:
 * "@spike/auth-discord/secure-sqlite" }`. The entrypoint contract (export
 * createDialect(config)) is the one every built-in adapter meets; it is a
 * public type, not a documented extension point.
 */
import { CompiledQuery, type DatabaseConnection, type Dialect, type Driver } from "kysely";
import { createDialect as emdashSqlite } from "emdash/db/sqlite";

export function createDialect(config: { url: string }): Dialect {
	const inner = emdashSqlite(config);
	return {
		createAdapter: () => inner.createAdapter(),
		createIntrospector: (db) => inner.createIntrospector(db),
		createQueryCompiler: () => inner.createQueryCompiler(),
		createDriver(): Driver {
			const driver = inner.createDriver();
			const ready = new WeakSet<DatabaseConnection>();
			return {
				init: () => driver.init(),
				async acquireConnection() {
					const connection = await driver.acquireConnection();
					if (!ready.has(connection)) {
						await connection.executeQuery(CompiledQuery.raw("PRAGMA secure_delete = ON"));
						ready.add(connection);
					}
					return connection;
				},
				beginTransaction: (c, s) => driver.beginTransaction(c, s),
				commitTransaction: (c) => driver.commitTransaction(c),
				rollbackTransaction: (c) => driver.rollbackTransaction(c),
				savepoint: driver.savepoint && ((c, n, q) => driver.savepoint!(c, n, q)),
				rollbackToSavepoint:
					driver.rollbackToSavepoint && ((c, n, q) => driver.rollbackToSavepoint!(c, n, q)),
				releaseSavepoint:
					driver.releaseSavepoint && ((c, n, q) => driver.releaseSavepoint!(c, n, q)),
				releaseConnection: (c) => driver.releaseConnection(c),
				destroy: () => driver.destroy(),
			};
		},
	};
}
