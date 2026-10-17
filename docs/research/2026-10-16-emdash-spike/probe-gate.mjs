// Q2: does a site gate stand in front of every /_emdash route?
// For each SPIKE_GATE mode, starts the built site and sends GET and POST to
// every route in routes.txt (params replaced with "x"). A /_emdash response
// that is not the gate's own refusal is a route the gate does not cover.
// Usage: node probe-gate.mjs   (after extracting routes.txt from the manifest)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const routes = readFileSync("./routes.txt", "utf8").trim().split("\n");
const toPath = (r) => r.replace(/\[\.\.\.[^\]]+\]/g, "x/y").replace(/\[[^\]]+\]/g, "x");

for (const [gate, header, port] of [
	["outer-deny", "x-outer-mw", 4324],
	["deny", "x-site-mw", 4325],
]) {
	const site = spawn("node", ["./dist/server/entry.mjs"], {
		cwd: "./site",
		env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", SPIKE_GATE: gate },
		stdio: "ignore",
	});
	try {
		for (let i = 0; ; i++) {
			try {
				await fetch(`http://127.0.0.1:${port}/`);
				break;
			} catch {}
			if (i > 100) throw new Error("site did not start");
			await new Promise((r) => setTimeout(r, 200));
		}
		let refused = 0;
		const leaks = [];
		const others = [];
		for (const r of routes) {
			for (const method of ["GET", "POST"]) {
				const res = await fetch(`http://127.0.0.1:${port}${toPath(r)}`, {
					method,
					redirect: "manual",
					headers: { "X-EmDash-Request": "1", "Content-Type": "application/json" },
					body: method === "POST" ? "{}" : undefined,
				});
				await res.arrayBuffer();
				const mark = res.headers.get(header);
				if (!r.startsWith("/_emdash")) {
					others.push(`${method} ${r} -> ${res.status} ${header}=${mark}`);
				} else if (res.status === 403 && mark === "deny") refused++;
				else leaks.push(`${method} ${r} -> ${res.status} ${header}=${mark}`);
			}
		}
		console.log(`\n== SPIKE_GATE=${gate}: ${refused} /_emdash requests refused by the gate, ${leaks.length} not`);
		for (const l of leaks) console.log(`  NOT GATED  ${l}`);
		for (const o of others) console.log(`  non-_emdash ${o}`);
	} finally {
		site.kill();
	}
}
