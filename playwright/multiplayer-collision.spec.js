// @ts-check
// 10 users draw concurrently near the same spot: patches merge pixel-by-
// pixel (see multiplayer-bridge.js), but the overlapping filled rects in
// this test are fully opaque throughout, so within the overlap it's still
// whichever the server processes last that wins - every client should
// converge on that same result regardless.
//
// Env vars (see helpers/local-partykit-server.js for the local default):
//   PARTYKIT_HOST - connect to a real deployed instance instead of spawning
//     a local throw-away server (needed for CI).
//   JSPAINT_URL - where the app is served from (default http://localhost:1999).
const { test, expect } = require("@playwright/test");
const path = require("path");
const { startLocalPartykitServer } = require("./helpers/local-partykit-server");

const JSPAINT_URL = process.env.JSPAINT_URL || "http://localhost:1999";
const PARTYKIT_TEST_PORT = 1998; // matches ggjh2027-multiplayer/partykit.json
const PARTYKIT_TEST_HOST = process.env.PARTYKIT_HOST || `ws://127.0.0.1:${PARTYKIT_TEST_PORT}`;
const SPAWN_LOCAL_PARTYKIT_SERVER = !process.env.PARTYKIT_HOST;
const MULTIPLAYER_SERVER_DIR = path.join(__dirname, "..", "..", "ggjh2027-multiplayer");

const NUM_USERS = 10;
const USER_COLORS = [
	"#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231",
	"#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#008080",
];

/** @type {{ stop: () => void } | undefined} */
let localServer;

test.beforeAll(async () => {
	if (!SPAWN_LOCAL_PARTYKIT_SERVER) {
		console.log(`PARTYKIT_HOST set - connecting to ${PARTYKIT_TEST_HOST} directly.`);
		return;
	}
	localServer = await startLocalPartykitServer({ cwd: MULTIPLAYER_SERVER_DIR, port: PARTYKIT_TEST_PORT });
});

test.afterAll(async () => {
	localServer?.stop();
});

test("10 concurrent users drawing near the same spot converge, but overwrite each other's bounding boxes", async ({ browser }) => {
	test.setTimeout(60000);

	const contexts = await Promise.all(
		Array.from({ length: NUM_USERS }, () => browser.newContext())
	);

	// Redirect each user's multiplayer connection to our test server and a
	// fresh room, without touching the real generated config file on disk.
	const roomId = `test-collision-${Date.now()}`;
	await Promise.all(contexts.map((context) =>
		context.route("**/src/multiplayer-config.js", (route) =>
			route.fulfill({
				contentType: "application/javascript",
				body: `export const PARTYKIT_HOST = ${JSON.stringify(PARTYKIT_TEST_HOST)};\nexport const MULTIPLAYER_ROOM_ID = ${JSON.stringify(roomId)};`,
			})
		)
	));

	const pages = await Promise.all(contexts.map((context) => context.newPage()));
	pages.forEach((page, i) => {
		page.on("console", (msg) => { if (msg.type() === "error") console.log(`[user ${i} console error]`, msg.text()); });
		page.on("pageerror", (err) => console.log(`[user ${i} pageerror]`, err.message));
	});

	// Connected one at a time, not all at once: local `partykit dev` doesn't
	// reliably accept many simultaneous first-time handshakes, and the client
	// has no reconnect logic, so a lost race is permanent. Retry on failure.
	for (const page of pages) {
		let connected = false;
		for (let attempt = 0; !connected && attempt < 5; attempt++) {
			if (attempt === 0) {
				await page.goto(JSPAINT_URL, { waitUntil: "domcontentloaded" });
			} else {
				await page.reload({ waitUntil: "domcontentloaded" });
			}
			await page.waitForFunction(() => "api_for_cypress_tests" in window);
			try {
				await page.waitForFunction(
					() => window.api_for_cypress_tests.is_multiplayer_connected === true,
					{ timeout: 3000 }
				);
				connected = true;
			} catch {
				// Not connected (handshake reset) - reload and retry.
			}
		}
		if (!connected) {
			throw new Error("A simulated user never connected to the test server after 5 attempts.");
		}
	}

	// Distinct color + filled Rectangle tool per user, so the result is easy
	// to read visually.
	await Promise.all(pages.map(async (page, i) => {
		await page.evaluate((color) => {
			// @ts-ignore - test-only API, see app.js
			window.api_for_cypress_tests.selected_colors.foreground = color;
		}, USER_COLORS[i]);
		await page.locator('.tool[title="Rectangle"]').click();
		await page.locator(".choose-shape-style .chooser-option").nth(2).click(); // fill-only style
	}));

	// Everyone draws a rectangle near the same point, jittered a little, at
	// the same time.
	const CENTER = { x: 600, y: 600 };
	await Promise.all(pages.map(async (page) => {
		const canvasBox = await page.evaluate(() => {
			const rect = document.querySelector("canvas.main-canvas").getBoundingClientRect();
			return { x: rect.x, y: rect.y };
		});
		const angle = Math.random() * Math.PI * 2;
		const dist = 20 + Math.random() * 30;
		const cx = CENTER.x + Math.cos(angle) * dist;
		const cy = CENTER.y + Math.sin(angle) * dist;
		const halfSize = 60 + Math.random() * 20;

		const x1 = canvasBox.x + cx - halfSize;
		const y1 = canvasBox.y + cy - halfSize;
		const x2 = canvasBox.x + cx + halfSize;
		const y2 = canvasBox.y + cy + halfSize;

		await page.mouse.move(x1, y1);
		await page.mouse.down();
		await page.mouse.move(x2, y2, { steps: 5 });
		await page.mouse.up();
	}));

	await Promise.all(pages.map((page) => page.waitForTimeout(8000))); // let sync settle

	// Every client should agree on the final color at the shared point.
	// Disagreement here would mean a real bug (non-deterministic resolution
	// across the room), not just the known overwrite trade-off.
	const finalColors = await Promise.all(pages.map((page) =>
		page.evaluate((point) => {
			const canvas = document.querySelector("canvas.main-canvas");
			const ctx = canvas.getContext("2d");
			const [r, g, b] = ctx.getImageData(point.x, point.y, 1, 1).data;
			return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
		}, CENTER)
	));
	console.log("finalColors per user:", finalColors);
	await Promise.all(pages.map((page, i) =>
		page.screenshot({ path: test.info().outputPath(`user-${i}.png`), clip: { x: 0, y: 0, width: 900, height: 900 } })
	));
	for (const color of finalColors) {
		expect(color).toBe(finalColors[0]);
	}

	await test.info().attach("ten-users-same-spot", {
		path: test.info().outputPath("user-0.png"),
		contentType: "image/png",
	});

	await Promise.all(contexts.map((context) => context.close()));
});
