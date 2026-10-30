// @ts-check
// E2E test for the "Disconnected" popup and its Reconnect button (see
// show_disconnected_message in src/multiplayer-client.js), driving real
// jspaint pages against a real local server.
//
// The connection is dropped with Playwright's WebSocket routing: every
// socket is proxied to the real server, and the test closes the page's side
// whenever it wants - deterministic, unlike stopping the server or flooding
// the rate limiter.
//
// Run with: npx playwright test playwright/reconnect.spec.js
// Needs jspaint served at JSPAINT_URL (`npm run dev`).
//
// Env vars (see helpers/local-wrangler-server.js for the local default):
//   PARTYKIT_HOST - connect to a real deployed instance instead of spawning
//     a local throw-away server (needed for CI).
//   JSPAINT_URL - where the app is served from (default http://localhost:1999).
const { test, expect } = require("@playwright/test");
const path = require("path");
const { startLocalWranglerServer } = require("./helpers/local-wrangler-server");

const JSPAINT_URL = process.env.JSPAINT_URL || "http://localhost:1999";
// Not 1998, so it runs alongside a developer's own `wrangler dev`.
const PARTYKIT_TEST_PORT = 1997;
const PARTYKIT_TEST_HOST = process.env.PARTYKIT_HOST || `ws://127.0.0.1:${PARTYKIT_TEST_PORT}`;
const SPAWN_LOCAL_PARTYKIT_SERVER = !process.env.PARTYKIT_HOST;
const MULTIPLAYER_SERVER_DIR = path.join(__dirname, "..", "..", "ggjh2027-multiplayer");
const MULTIPLAYER_SOCKET = /\/parties\/main\//;

/** @type {{ stop: () => void } | undefined} */
let localServer;

test.beforeAll(async () => {
	if (!SPAWN_LOCAL_PARTYKIT_SERVER) {
		console.log(`PARTYKIT_HOST set - connecting to ${PARTYKIT_TEST_HOST} directly.`);
		return;
	}
	localServer = await startLocalWranglerServer({ cwd: MULTIPLAYER_SERVER_DIR, port: PARTYKIT_TEST_PORT });
});

test.afterAll(() => {
	localServer?.stop();
});

const freshRoomId = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * @param {import("@playwright/test").BrowserContext} context
 * @param {string} [roomId]
 */
async function pointAtTestServer(context, roomId = freshRoomId()) {
	await context.route("**/src/multiplayer-config.js", (route) =>
		route.fulfill({
			contentType: "application/javascript",
			body: `export const PARTYKIT_HOST = ${JSON.stringify(PARTYKIT_TEST_HOST)};\nexport const MULTIPLAYER_ROOM_ID = ${JSON.stringify(roomId)};`,
		})
	);
}

/**
 * Proxies every multiplayer socket in the context to the real server and
 * keeps hold of the latest one, so the test can drop it. On the context, not
 * the page, so it still applies after Reconnect reloads the page.
 * @param {import("@playwright/test").BrowserContext} context
 * @param {{ refuseFirst?: boolean }} [options] - refuseFirst: close the first
 *   connection straight away, without ever reaching the server.
 */
async function proxyMultiplayerSockets(context, { refuseFirst = false } = {}) {
	/** @type {import("@playwright/test").WebSocketRoute | undefined} */
	let latest;
	let connections = 0;
	await context.routeWebSocket(MULTIPLAYER_SOCKET, (ws) => {
		connections++;
		latest = ws;
		if (refuseFirst && connections === 1) {
			ws.close();
			return;
		}
		ws.connectToServer();
	});
	return {
		/** Closes the page's side, as if the network or server dropped it. */
		drop: async () => {
			if (!latest) { throw new Error("No multiplayer socket to drop"); }
			await latest.close();
		},
		get connections() { return connections; },
	};
}

/** @param {import("@playwright/test").Page} page */
async function waitForConnected(page) {
	await page.waitForFunction(() => "api_for_cypress_tests" in window);
	await page.waitForFunction(() => window.api_for_cypress_tests.is_multiplayer_connected === true, null, { timeout: 10000 });
	// Connected (the welcome message) comes before the room's history is drawn.
	await expect(page.locator(".multiplayer-loading-overlay")).toHaveCount(0, { timeout: 10000 });
}

/** @param {import("@playwright/test").Page} page */
const isConnected = (page) => page.evaluate(() => window.api_for_cypress_tests.is_multiplayer_connected);

/** @param {import("@playwright/test").Page} page */
const disconnectedPopup = (page) => page.locator(".window:visible").filter({ hasText: "Disconnected" }).filter({ has: page.getByRole("button", { name: "Reconnect" }) });

// Far from the top-left watermark (see multiplayer-watermark.js).
const MARK = { x: 3000, y: 1500, size: 10 };

/**
 * Sends a solid red square straight over the real connection, as if drawn,
 * and waits for the server to store it (its echo).
 * @param {import("@playwright/test").Page} page
 */
async function drawRedSquare(page) {
	await page.evaluate(({ x, y, size }) => {
		const canvas = document.createElement("canvas");
		canvas.width = size;
		canvas.height = size;
		const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
		ctx.fillStyle = "#ff0000";
		ctx.fillRect(0, 0, size, size);
		window.api_for_cypress_tests.send_raw_multiplayer_message_for_test({
			type: "patch",
			patch: {
				id: `reconnect-test-${Date.now()}`,
				toolId: "TOOL_PENCIL",
				toolLabel: "Pencil",
				timestamp: Date.now(),
				rect: { x, y, w: size, h: size },
				canvasSize: { width: 3840, height: 2160 },
				image: { mimeType: "image/png", data: canvas.toDataURL("image/png").split(",")[1] },
			},
		});
	}, MARK);
}

/**
 * @param {import("@playwright/test").Page} page
 * @returns {Promise<string>} "r,g,b,a" of the mark's center
 */
const markPixel = (page) => page.evaluate(({ x, y, size }) => {
	const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector("canvas.main-canvas"));
	const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
	return Array.from(ctx.getImageData(x + size / 2, y + size / 2, 1, 1).data).join(",");
}, MARK);

test.describe("reconnecting after a disconnect", () => {
	test("a dropped connection shows the popup, and Reconnect rejoins the same room", async ({ page, context }) => {
		test.setTimeout(45000);
		await pointAtTestServer(context);
		const sockets = await proxyMultiplayerSockets(context);
		await page.goto(JSPAINT_URL, { waitUntil: "domcontentloaded" });
		await waitForConnected(page);

		// Something in the room to find again after reconnecting.
		await drawRedSquare(page);
		await expect.poll(() => markPixel(page)).toBe("255,0,0,255");

		await sockets.drop();

		const popup = disconnectedPopup(page);
		await expect(popup).toBeVisible({ timeout: 5000 });
		await expect(popup).toContainText("You've been disconnected from the shared canvas");
		expect(await isConnected(page)).toBe(false);

		await Promise.all([
			page.waitForEvent("load"),
			popup.getByRole("button", { name: "Reconnect", exact: true }).click(),
		]);
		await waitForConnected(page);

		expect(sockets.connections).toBe(2);
		await expect(disconnectedPopup(page)).toHaveCount(0);
		// Rebuilt from the room's history on the server, so it's the same room.
		await expect.poll(() => markPixel(page)).toBe("255,0,0,255");
	});

	test("a failed first connection says so, and Reconnect connects", async ({ page, context }) => {
		test.setTimeout(45000);
		await pointAtTestServer(context);
		const sockets = await proxyMultiplayerSockets(context, { refuseFirst: true });
		await page.goto(JSPAINT_URL, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => "api_for_cypress_tests" in window);

		const popup = disconnectedPopup(page);
		await expect(popup).toBeVisible({ timeout: 10000 });
		await expect(popup).toContainText("Couldn't connect to the shared canvas");
		// Still usable offline: the loading overlay doesn't block drawing forever.
		await expect(page.locator(".multiplayer-loading-overlay")).toHaveCount(0);

		await Promise.all([
			page.waitForEvent("load"),
			popup.getByRole("button", { name: "Reconnect", exact: true }).click(),
		]);
		await waitForConnected(page);
		expect(sockets.connections).toBe(2);
		await expect(disconnectedPopup(page)).toHaveCount(0);
	});

	test("Close dismisses the popup and stays offline, without reloading", async ({ page, context }) => {
		test.setTimeout(45000);
		await pointAtTestServer(context);
		const sockets = await proxyMultiplayerSockets(context);
		await page.goto(JSPAINT_URL, { waitUntil: "domcontentloaded" });
		await waitForConnected(page);
		await page.evaluate(() => { window.__sameDocument = true; });

		await sockets.drop();
		const popup = disconnectedPopup(page);
		await expect(popup).toBeVisible({ timeout: 5000 });
		await popup.getByRole("button", { name: "Close", exact: true }).click();

		await expect(disconnectedPopup(page)).toHaveCount(0);
		expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
		expect(await isConnected(page)).toBe(false);
		expect(sockets.connections).toBe(1);
	});

	test("one disconnect shows exactly one popup", async ({ page, context }) => {
		test.setTimeout(45000);
		await pointAtTestServer(context);
		const sockets = await proxyMultiplayerSockets(context);
		await page.goto(JSPAINT_URL, { waitUntil: "domcontentloaded" });
		await waitForConnected(page);

		await sockets.drop();
		await expect(disconnectedPopup(page)).toBeVisible({ timeout: 5000 });
		// Give a stray second "close"/"error" handler a chance to show another.
		await page.waitForTimeout(1000);
		await expect(disconnectedPopup(page)).toHaveCount(1);
	});
});
