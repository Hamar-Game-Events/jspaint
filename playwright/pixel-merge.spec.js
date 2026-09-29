// @ts-check
// Patches merge pixel-by-pixel, not as opaque rectangle overwrites (see
// build_masked_image_data in multiplayer-bridge.js): a stroke whose bounding
// rect happens to overlap someone else's unrelated drawing should only
// touch the pixels it actually changed, leaving the rest of that rect intact.
//
// The interesting case is specifically when the drawer's own canvas hasn't
// received that other drawing yet at the moment they draw (the real-world
// race this fixes) - a single page drawing both shapes itself can't tell
// old and new behavior apart, since its own canvas already has everything
// merged locally by the time it crops either patch. Playwright's WebSocket
// routing holds back delivery of the first shape to the drawer specifically,
// to reproduce that race deterministically instead of relying on timing.
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
// Drawing a filled shape is admin-only (see ADMIN_ONLY tool/style checks) -
// the squarer below needs to connect as admin to legitimately produce the
// filled square this test's merge behavior depends on. Pinned via --var
// when spawning our own throw-away server so the test doesn't depend on
// whatever's in the multiplayer repo's own .dev.vars; against a real
// deployed instance (PARTYKIT_HOST set), this must match its actual secret.
const ADMIN_SECRET = process.env.MULTIPLAYER_ADMIN_SECRET || "test-admin-secret";

/** @type {{ stop: () => void } | undefined} */
let localServer;

test.beforeAll(async () => {
	if (!SPAWN_LOCAL_PARTYKIT_SERVER) {
		console.log(`PARTYKIT_HOST set - connecting to ${PARTYKIT_TEST_HOST} directly.`);
		return;
	}
	localServer = await startLocalWranglerServer({
		cwd: MULTIPLAYER_SERVER_DIR,
		port: PARTYKIT_TEST_PORT,
		extraArgs: ["--var", `ADMIN_SECRET:${ADMIN_SECRET}`],
	});
});

test.afterAll(async () => {
	localServer?.stop();
});

/**
 * @param {import("@playwright/test").BrowserContext} context
 * @param {string} roomId
 */
async function pointAtTestServer(context, roomId) {
	await context.route("**/src/multiplayer-config.js", (route) =>
		route.fulfill({
			contentType: "application/javascript",
			body: `export const PARTYKIT_HOST = ${JSON.stringify(PARTYKIT_TEST_HOST)};\nexport const MULTIPLAYER_ROOM_ID = ${JSON.stringify(roomId)};`,
		})
	);
}

/** @param {import("@playwright/test").Page} page */
async function connect(page) {
	await page.goto(JSPAINT_URL, { waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => "api_for_cypress_tests" in window);
	await page.waitForFunction(() => window.api_for_cypress_tests.is_multiplayer_connected === true, { timeout: 5000 });
}

/**
 * @param {import("@playwright/test").Page} page
 * @returns {Promise<{x: number, y: number}>}
 */
async function getCanvasOrigin(page) {
	return page.evaluate(() => {
		const rect = document.querySelector("canvas.main-canvas").getBoundingClientRect();
		return { x: rect.x, y: rect.y };
	});
}

/**
 * @param {import("@playwright/test").Page} page
 * @param {{x: number, y: number}} point - canvas-relative
 * @returns {Promise<string>} "#rrggbb"
 */
async function colorAt(page, point) {
	return page.evaluate((p) => {
		const canvas = document.querySelector("canvas.main-canvas");
		const ctx = canvas.getContext("2d");
		const [r, g, b] = ctx.getImageData(p.x, p.y, 1, 1).data;
		return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
	}, point);
}

test("a stroke whose bounding box overlaps a drawing the artist hasn't received yet still preserves it for everyone else", async ({ browser }) => {
	test.setTimeout(30000);

	const roomId = `test-pixel-merge-${Date.now()}`;
	const squarerContext = await browser.newContext();
	const drawerContext = await browser.newContext();
	const observerContext = await browser.newContext();
	await Promise.all([
		pointAtTestServer(squarerContext, roomId),
		pointAtTestServer(drawerContext, roomId),
		pointAtTestServer(observerContext, roomId),
	]);
	// The squarer draws a fill-style shape below, which is admin-only -
	// multiplayer-client.js reads this from localStorage before it ever
	// connects, so it has to be set before the page loads.
	await squarerContext.addInitScript((secret) => {
		localStorage.multiplayer_admin_secret = secret;
	}, ADMIN_SECRET);

	// Holds back every incoming "patch" from the drawer specifically (not
	// the squarer or observer), releasing them only once told to - this is
	// what makes the race deterministic instead of timing-dependent.
	/** @type {Array<() => void>} */
	let releaseHeldPatches = [];
	let holdingPatches = true;
	await drawerContext.routeWebSocket(/\/parties\/main\//, (ws) => {
		const server = ws.connectToServer();
		server.onMessage((message) => {
			const forward = () => ws.send(message);
			if (holdingPatches && typeof message === "string" && message.includes("\"type\":\"patch\"")) {
				releaseHeldPatches.push(forward);
			} else {
				forward();
			}
		});
	});

	const squarer = await squarerContext.newPage();
	const drawer = await drawerContext.newPage();
	const observer = await observerContext.newPage();
	await connect(squarer);
	await connect(drawer);
	await connect(observer);

	const origin = await getCanvasOrigin(squarer);

	// A small filled square, sent before the drawer draws anything - held
	// back from the drawer's own page, but not from the observer.
	await squarer.evaluate((color) => {
		// @ts-ignore - test-only API, see app.js
		window.api_for_cypress_tests.selected_colors.foreground = color;
	}, "#e6194b");
	await squarer.locator('.tool[title="Rectangle"]').click();
	await squarer.locator(".choose-shape-style .chooser-option").nth(2).click(); // fill-only style
	const square = { x1: origin.x + 150, y1: origin.y + 150, x2: origin.x + 200, y2: origin.y + 200 };
	await squarer.mouse.move(square.x1, square.y1);
	await squarer.mouse.down();
	await squarer.mouse.move(square.x2, square.y2, { steps: 3 });
	await squarer.mouse.up();
	await observer.waitForTimeout(500); // let it reach the server and the observer

	// The drawer's own canvas has no idea the square exists (held back) -
	// this diagonal pencil line's bounding box fully encloses it anyway.
	await drawer.locator('.tool[title="Pencil"]').click();
	const lineStart = { x: origin.x + 120, y: origin.y + 250 };
	const lineEnd = { x: origin.x + 250, y: origin.y + 120 };
	await drawer.mouse.move(lineStart.x, lineStart.y);
	await drawer.mouse.down();
	await drawer.mouse.move(lineEnd.x, lineEnd.y, { steps: 10 });
	await drawer.mouse.up();
	await observer.waitForTimeout(500); // let the line reach the server and the observer

	holdingPatches = false;
	for (const release of releaseHeldPatches) { release(); }

	// Sampled just inside the square's near corner, away from the diagonal's
	// actual path - still fully within the line's bounding box, though.
	const point = { x: 155, y: 195 };
	const observerColor = await colorAt(observer, point);
	expect(observerColor).toBe("#e6194b");

	await squarerContext.close();
	await drawerContext.close();
	await observerContext.close();
});
