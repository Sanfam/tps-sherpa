import type { APIRoute } from "astro";
import { memberRoles } from "../../../auth.ts";
import { ADMIN, editorRole } from "../../../emdash-auth.ts";
import { purgeHistory } from "../../../emdash-erasure.ts";

export const POST: APIRoute = async ({ request, url }) => {
  // Same-origin POSTs carry Origin; requiring it blocks cross-site cookie submissions.
  if (request.headers.get("origin") !== url.origin) return new Response(null, { status: 403 });
  const { roles } = await memberRoles(request.headers);
  if (!roles || editorRole(roles) !== ADMIN) return new Response(null, { status: 403 });
  try {
    const body = (await request.json()) as { collection?: unknown; entryId?: unknown };
    if (typeof body.collection !== "string" || typeof body.entryId !== "string") return new Response(null, { status: 400 });
    purgeHistory(body.collection, body.entryId);
    return Response.json({ ok: true });
  } catch (error) {
    return new Response(error instanceof Error && error.message === "entry not found" ? null : "bad request", {
      status: error instanceof Error && error.message === "entry not found" ? 404 : 400,
    });
  }
};
