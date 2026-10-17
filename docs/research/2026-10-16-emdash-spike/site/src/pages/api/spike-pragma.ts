// Spike only: reads PRAGMA secure_delete on EmDash's database, through
// `getDb()` from emdash/runtime (the instance public pages read with).
import type { APIRoute } from "astro";
import { getDb } from "emdash/runtime";
import { sql } from "kysely";

export const prerender = false;

export const GET: APIRoute = async () => {
	const db = await getDb();
	const { rows } = await sql<{ secure_delete: number }>`PRAGMA secure_delete`.execute(db);
	return Response.json(rows[0]);
};
