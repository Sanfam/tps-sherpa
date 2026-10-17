// Usage: node measure.mjs <app-dir> <port> <idle-seconds> <path> [<path>...]
// Starts <app-dir>/dist/server/entry.mjs, samples its RSS and %CPU after
// <idle-seconds> with no requests, after 50 requests spread over the paths,
// and again after 30 s of idle. Kills the server at the end.
import { execSync, spawn } from "node:child_process";

const [dir, port, idleS, ...paths] = process.argv.slice(2);
const server = spawn("node", ["./dist/server/entry.mjs"], {
	cwd: dir,
	env: { ...process.env, PORT: port, HOST: "127.0.0.1" },
	stdio: "ignore",
});
const sample = (label) => {
	const [rss, cpu] = execSync(`ps -o rss=,%cpu= -p ${server.pid}`).toString().trim().split(/\s+/);
	console.log(JSON.stringify({ label, rssMB: +(rss / 1024).toFixed(1), cpu: +cpu }));
};
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));

try {
	await wait(+idleS);
	sample(`idle ${idleS}s, no requests yet`);
	const statuses = {};
	for (let i = 0; i < 50; i++) {
		const p = paths[i % paths.length];
		const res = await fetch(`http://127.0.0.1:${port}${p}`, {
			redirect: "manual",
			signal: AbortSignal.timeout(20_000),
		});
		await res.arrayBuffer();
		statuses[`${p} ${res.status}`] = (statuses[`${p} ${res.status}`] ?? 0) + 1;
	}
	sample("right after 50 requests");
	console.log(JSON.stringify(statuses));
	await wait(30);
	sample("idle 30s after requests");
} finally {
	server.kill();
}
