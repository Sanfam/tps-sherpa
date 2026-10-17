// The site's own middleware, as the reader-auth session middleware would be.
// It marks every response it sees, and with SPIKE_GATE=deny refuses all of
// /_emdash, so the gate test can tell which routes it actually stands in front of.
import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (context, next) => {
	if (process.env.SPIKE_GATE === "deny" && context.url.pathname.startsWith("/_emdash")) {
		return new Response("site gate", { status: 403, headers: { "x-site-mw": "deny" } });
	}
	const response = await next();
	try {
		response.headers.set("x-site-mw", "1");
	} catch {
		return new Response(response.body, {
			status: response.status,
			headers: { ...Object.fromEntries(response.headers), "x-site-mw": "1" },
		});
	}
	return response;
});
