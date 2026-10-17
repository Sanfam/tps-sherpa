// EmDash's `middleware.outer` hook: runs before every EmDash middleware.
// With SPIKE_GATE=outer-deny it refuses all of /_emdash.
import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (context, next) => {
	if (process.env.SPIKE_GATE === "outer-deny" && context.url.pathname.startsWith("/_emdash")) {
		return new Response("outer gate", { status: 403, headers: { "x-outer-mw": "deny" } });
	}
	const response = await next();
	try {
		response.headers.set("x-outer-mw", "1");
	} catch {
		return new Response(response.body, {
			status: response.status,
			headers: { ...Object.fromEntries(response.headers), "x-outer-mw": "1" },
		});
	}
	return response;
});
