// @ts-check
// Spins up (and tears down) a throw-away local `wrangler dev` process, so
// tests never touch a developer's own manually-started server/room. The
// multiplayer server moved from PartyKit to raw Cloudflare Workers +
// PartyServer a while back - this replaces the old `partykit dev`-based
// helper, which stopped working entirely once that migration landed.
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

/**
 * @param {object} options
 * @param {string} options.cwd - the multiplayer server project's directory
 *   (where its wrangler.jsonc lives).
 * @param {number} options.port
 * @param {string[]} [options.extraArgs] - e.g. ["--var", "ADMIN_SECRET:test-secret"]
 *   to pin a known value instead of depending on the dev's own .dev.vars.
 * @param {number} [options.readyTimeoutMs]
 * @returns {Promise<{ stop: () => void }>}
 */
async function startLocalWranglerServer({ cwd, port, extraArgs = [], readyTimeoutMs = 20000 }) {
	// Neither wrangler dev's devtools inspector port nor its local DO/SQLite
	// persistence directory are derived from --port, so running more than
	// one of these (e.g. multiple spec files) at once collides on both
	// unless each gets its own.
	const inspectorPort = port + 10000;
	const persistTo = path.join(os.tmpdir(), `jspaint-wrangler-dev-test-state-${port}`);
	// detached: true makes the child its own process group leader, so
	// stop() can kill -pid to take the whole process tree with it - spawn()'s
	// own .kill() only signals the direct npx child, not the workerd
	// grandchild underneath, which can otherwise keep stdio open after exit.
	const wranglerProcess = spawn(
		"npx",
		["wrangler", "dev", "--port", String(port), "--inspector-port", String(inspectorPort), "--persist-to", persistTo, ...extraArgs],
		{ cwd, stdio: "pipe", detached: true },
	);

	await new Promise((resolve, reject) => {
		let output = "";
		let settled = false;
		const onData = (data) => {
			output += data.toString();
			if (!settled && output.includes("Ready on")) {
				settled = true;
				resolve(undefined);
			}
		};
		wranglerProcess.stdout.on("data", onData);
		wranglerProcess.stderr.on("data", onData);
		wranglerProcess.on("error", (error) => { if (!settled) { settled = true; reject(error); } });
		setTimeout(() => {
			if (!settled) { settled = true; reject(new Error(`Test wrangler server didn't start in time. Output so far:\n${output}`)); }
		}, readyTimeoutMs);
	});

	// "Ready on" fires slightly before it can actually accept WebSocket
	// upgrades - a short settle buffer avoids that race.
	await new Promise((resolve) => setTimeout(resolve, 2000));

	return {
		stop: () => {
			try {
				process.kill(-wranglerProcess.pid, "SIGTERM");
			} catch {
				wranglerProcess.kill("SIGTERM"); // group already gone, or never detached - fall back to the direct child
			}
		},
	};
}

module.exports = { startLocalWranglerServer };
