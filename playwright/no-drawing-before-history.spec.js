// @ts-check
// Regression test for the "Xiaomi bug": on a slow connection, a user who
// started drawing before the handshake finished would have every stroke
// queued client-side, then flushed as one synchronous burst the instant the
// connection opened - instantly blowing through the server's small
// per-connection rate-limit bucket and getting disconnected. Real devices
// only reproduced this on a slow enough handshake; here we hold back the
// server's "history" message deterministically instead of relying on a
// slow network.
//
// The fix (see multiplayer-loading-overlay.js) blocks drawing entirely
// until history has been replayed, so there's no longer anything to queue
// in the first place - this test proves that invariant holds by holding
// history back indefinitely and confirming a real drawing gesture during
// that window produces zero "patch" messages, then that drawing resumes
// normally once history arrives.
//
// Env vars (see helpers/local-wrangler-server.js for the local default):
//   PARTYKIT_HOST - connect to a real deployed instance instead of spawning
//     a local throw-away server (needed for CI).
//   JSPAINT_URL - where the app is served from (default http://localhost:1999).
const { test, expect } = require("@playwright/test");
const path = require("path");
const { startLocalWranglerServer } = require("./helpers/local-wrangler-server");

const JSPAINT_URL = process.env.JSPAINT_URL || "http://localhost:1999";
const PARTYKIT_TEST_PORT = 1998; // matches ggjh2027-multiplayer/partykit.json
const PARTYKIT_TEST_HOST = process.env.PARTYKIT_HOST || `ws://127.0.0.1:${PARTYKIT_TEST_PORT}`;
const SPAWN_LOCAL_PARTYKIT_SERVER = !process.env.PARTYKIT_HOST;
const MULTIPLAYER_SERVER_DIR = path.join(__dirname, "..", "..", "ggjh2027-multiplayer");

/** @type {{ stop: () => void } | undefined} */
let localServer;

test.beforeAll(async () => {
	if (!SPAWN_LOCAL_PARTYKIT_SERVER) {
		console.log(`PARTYKIT_HOST set - connecting to ${PARTYKIT_TEST_HOST} directly.`);
		return;
	}
	localServer = await startLocalWranglerServer({ cwd: MULTIPLAYER_SERVER_DIR, port: PARTYKIT_TEST_PORT });
});

test.afterAll(async () => {
	localServer?.stop();
});

/** @param {import("@playwright/test").Page} page */
async function getCanvasOrigin(page) {
	return page.evaluate(() => {
		const rect = document.querySelector("canvas.main-canvas").getBoundingClientRect();
		return { x: rect.x, y: rect.y };
	});
}

/**
 * A drag gesture over the canvas, as if the user were drawing with a
 * finger or pencil - identical regardless of whether the loading overlay
 * is currently covering it.
 * @param {import("@playwright/test").Page} page
 * @param {{x: number, y: number}} origin
 */
async function attemptToDraw(page, origin) {
	await page.mouse.move(origin.x + 50, origin.y + 50);
	await page.mouse.down();
	await page.mouse.move(origin.x + 120, origin.y + 120, { steps: 5 });
	await page.mouse.up();
}

test("a slow connection can no longer queue up a burst of patches, because drawing is blocked until history has loaded", async ({ page, context }) => {
	test.setTimeout(30000);
	const roomId = `test-no-draw-before-history-${Date.now()}`;
	await context.route("**/src/multiplayer-config.js", (route) =>
		route.fulfill({
			contentType: "application/javascript",
			body: `export const PARTYKIT_HOST = ${JSON.stringify(PARTYKIT_TEST_HOST)};\nexport const MULTIPLAYER_ROOM_ID = ${JSON.stringify(roomId)};`,
		})
	);

	/** @type {string[]} */
	const patchesSentToServer = [];
	/** @type {(() => void) | undefined} */
	let releaseHistory;
	const historyHeld = new Promise((resolve) => { releaseHistory = resolve; });

	await context.routeWebSocket(/\/parties\/main\//, (ws) => {
		const server = ws.connectToServer();
		server.onMessage(async (message) => {
			if (typeof message === "string" && message.includes("\"type\":\"history\"")) {
				await historyHeld; // simulates however slow a real handshake/history load could be
			}
			ws.send(message);
		});
		ws.onMessage((message) => {
			if (typeof message === "string" && message.includes("\"type\":\"patch\"")) {
				patchesSentToServer.push(message);
			}
			server.send(message);
		});
	});

	await page.goto(JSPAINT_URL, { waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => "api_for_cypress_tests" in window);
	// "welcome" (which flips this flag) arrives well before the held-back
	// "history" - this is the exact slow-connection window the Xiaomi bug
	// lived in, so it's the one worth trying to draw into.
	await page.waitForFunction(() => window.api_for_cypress_tests.is_multiplayer_connected === true, { timeout: 10000 });
	await expect(page.locator(".multiplayer-loading-overlay")).toBeVisible();

	const origin = await getCanvasOrigin(page);
	for (let i = 0; i < 5; i++) {
		await attemptToDraw(page, origin);
	}
	await page.waitForTimeout(300); // let anything that was going to be sent actually reach our interceptor

	expect(patchesSentToServer.length).toBe(0);

	releaseHistory();
	await expect(page.locator(".multiplayer-loading-overlay")).toBeHidden({ timeout: 10000 });

	// Drawing isn't just blocked forever - it works normally once unblocked.
	await attemptToDraw(page, origin);
	await expect.poll(() => patchesSentToServer.length, { timeout: 5000 }).toBe(1);
});
