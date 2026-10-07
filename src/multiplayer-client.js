// @ts-check
/* global main_ctx */
import { initMultiplayerBridge, noteExternalCanvasChange } from "./multiplayer-bridge.js";
import { is_multiplayer_mode, set_is_admin_connection } from "./helpers.js";
import { show_error_message, update_helper_layer } from "./functions.js";
import { updateOnlineCount } from "./multiplayer-user-count.js";
import { hideRemoteCursor, showRemoteCursor, startBroadcastingCursor } from "./multiplayer-cursors.js";
import { hideLoadingOverlay, showLoadingOverlay } from "./multiplayer-loading-overlay.js";
// Generated from the PARTYKIT_HOST env var at dev/install time - see
// scripts/generate-multiplayer-config.js. Not checked in (per .gitignore);
// run `npm install` or `npm run dev` at the repo root if this import 404s.
import { PARTYKIT_HOST, MULTIPLAYER_ROOM_ID } from "./multiplayer-config.js";

// Every visitor connects to the same room. The page embedding jspaint picks it
// with ?room=<id> (the Game Jam website passes the room set in Sanity), so the
// canvas can be switched without redeploying. Without one, falls back to
// MULTIPLAYER_ROOM_ID from generate-multiplayer-config.js.
const ROOM_ID = room_id_from_url() ?? MULTIPLAYER_ROOM_ID;

/** @returns {string | null} */
function room_id_from_url() {
	const room = new URLSearchParams(location.search).get("room");
	if (room === null) return null;
	if (/^[\w-]{1,64}$/.test(room)) return room;
	console.warn(`Ignoring invalid ?room=${JSON.stringify(room)}; using ${MULTIPLAYER_ROOM_ID}`);
	return null;
}

// Test-only (see window.api_for_cypress_tests in app.js): true once the
// handshake completes - unlike is_admin_connection, which starts false for
// both "not connected" and "connected but not admin".
export let is_connected = false;

// Test-only (see window.api_for_cypress_tests in app.js): sends a raw
// message through the real connection, bypassing jspaint's own drawing
// pipeline. Needed for E2E-testing the rate limiter - real gesture
// simulation (even synthetic, in-page events) can't reliably outrun the
// server's refill rate, since jspaint's own per-gesture processing cost
// already exceeds it.
export let send_raw_message_for_test = (_message) => {};

/**
 * @param {Blob} blob
 * @returns {Promise<string>} base64, no "data:...;base64," prefix
 */
async function blob_to_base64(blob) {
	const buffer = await blob.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/**
 * @param {string} base64
 * @param {string} mimeType
 * @returns {Promise<ImageBitmap>}
 */
async function base64_to_image_bitmap(base64, mimeType) {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return createImageBitmap(new Blob([bytes], { type: mimeType }));
}

/**
 * Draws a patch directly, bypassing undoable()/history - a remote patch
 * shouldn't become a history node, and drawing it as one would re-trigger
 * multiplayer-bridge.js and echo it back out.
 * @param {{rect: {x: number, y: number, w: number, h: number}, image: {mimeType: string, data: string}}} patch
 */
async function apply_patch_to_canvas(patch) {
	const bitmap = await base64_to_image_bitmap(patch.image.data, patch.image.mimeType);
	main_ctx.drawImage(bitmap, patch.rect.x, patch.rect.y);
	bitmap.close();
}

function initMultiplayerClient() {
	if (!is_multiplayer_mode) { return; }

	// Blurred + drawing-blocked until the "history" handler below hides it -
	// see multiplayer-loading-overlay.js.
	showLoadingOverlay();

	// Admins set this manually via the console - localStorage.multiplayer_admin_secret
	// = "..." - never passed through the URL. See server.ts in the separate
	// ggjh2027-multiplayer repo for the actual check.
	const admin_token = localStorage.multiplayer_admin_secret;

	const url = new URL(`${PARTYKIT_HOST}/parties/main/${ROOM_ID}`);
	if (admin_token) {
		url.searchParams.set("admin", admin_token);
	}
	const ws = new WebSocket(url);
	// Holds messages sent before the connection is actually open (e.g. the
	// user starts drawing or moving the pointer while a slow handshake is
	// still in progress). Objects, not pre-stringified - so a queued cursor
	// update can be superseded by a newer one instead of replaying every
	// stale position once connected.
	/** @type {object[]} */
	const send_queue = [];

	/** @param {object} message */
	const send = (message) => {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(message));
			return;
		}
		// Only the latest position matters - an older queued one is moot,
		// and replaying a long backlog of them on open is exactly the kind
		// of burst that used to trip the server's cursor rate limit
		// instantly on a slow connection.
		if (message.type === "cursor" || message.type === "cursor-left") {
			const stale_index = send_queue.findIndex((m) => m.type === "cursor" || m.type === "cursor-left");
			if (stale_index !== -1) {
				send_queue.splice(stale_index, 1);
			}
		}
		send_queue.push(message);
	};
	send_raw_message_for_test = send;

	// Matches the server's PATCH_RATE_LIMIT_REFILL_MS (see server.ts in the
	// ggjh2027-multiplayer repo) - queued patches (real committed strokes,
	// can't just drop the stale ones like cursor updates above) are paced
	// out at the same rate the bucket refills, instead of all firing
	// synchronously in one burst the instant the connection opens.
	const QUEUE_FLUSH_INTERVAL_MS = 150;
	ws.addEventListener("open", async () => {
		const queued = send_queue.splice(0, send_queue.length);
		for (const message of queued) {
			ws.send(JSON.stringify(message));
			if (message.type === "patch") {
				await new Promise((resolve) => setTimeout(resolve, QUEUE_FLUSH_INTERVAL_MS));
			}
		}
	});

	// jspaint applies our own strokes locally the instant they're drawn -
	// out of band from the network, so a concurrent remote patch can arrive
	// and get applied while our own patch is still in flight. The server
	// echoes our own patches back (see server.ts) so we can reconcile: id ->
	// count of *other* patches applied since we sent it. If a patch comes
	// back matching one of our own pending ids with count 0, nothing
	// interleaved - it's already correctly rendered, skip re-applying it
	// (drawing the same patch on top of itself is a lossy no-op for
	// anti-aliased/partially-transparent pixels, not a true no-op). If count
	// > 0, something else was applied in between and our own patch needs to
	// go on top of that (in true server order) to match every other client.
	/** @type {Map<string, number>} */
	const pending_own_patches = new Map();

	// Each "message" event spawns an independent async handler, and
	// apply_patch_to_canvas() awaits a variable-duration createImageBitmap() -
	// without chaining, two patches can decode out of order and draw the
	// older one on top. Queue keeps handling strictly in arrival order.
	let message_queue = Promise.resolve();
	ws.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		message_queue = message_queue
			.then(() => handle_message(message))
			.catch((error) => console.error("Failed to handle multiplayer message:", error));
	});

	/** @param {object} message */
	async function handle_message(message) {
		if (message.type === "welcome") {
			is_connected = true;
			set_is_admin_connection(message.isAdmin);
		} else if (message.type === "history") {
			for (const patch of message.patches) {
				await apply_patch_to_canvas(patch);
			}
			// Once, after the whole batch - not per patch, since it's a full-canvas
			// snapshot and nothing reads it again until a local edit is made.
			noteExternalCanvasChange();
			// Otherwise the helper layer (and thumbnail window, if open) only
			// redraw on local pointer activity - a remote patch would sit
			// invisible in the thumbnail until the next local mousemove.
			update_helper_layer();
			hideLoadingOverlay();
		} else if (message.type === "patch") {
			if (pending_own_patches.has(message.patch.id)) {
				const interleaved_count = pending_own_patches.get(message.patch.id);
				pending_own_patches.delete(message.patch.id);
				if (interleaved_count === 0) {
					return; // already correctly rendered locally, nothing to reconcile
				}
			} else {
				for (const [id, count] of pending_own_patches) {
					pending_own_patches.set(id, count + 1);
				}
			}
			await apply_patch_to_canvas(message.patch);
			noteExternalCanvasChange();
			update_helper_layer();
		} else if (message.type === "patch-rejected") {
			// A rejected patch is never echoed back, so it'd otherwise never
			// get cleared from pending_own_patches.
			pending_own_patches.delete(message.id);
			show_error_message(message.reason);
		} else if (message.type === "presence") {
			updateOnlineCount(message.count);
		} else if (message.type === "cursors") {
			for (const [id, cursor] of Object.entries(message.cursors)) {
				showRemoteCursor(id, cursor.x, cursor.y, cursor.image);
			}
		} else if (message.type === "cursor") {
			showRemoteCursor(message.id, message.x, message.y, message.image);
		} else if (message.type === "cursor-left") {
			hideRemoteCursor(message.id);
		}
	}

	ws.addEventListener("error", () => {
		show_error_message("Couldn't connect to the shared canvas server. Your changes aren't being saved or shared right now.");
		// Without this, a handshake failure would leave the canvas blurred
		// and undrawable forever - there's no reconnect logic, so this is
		// the only chance to let the user draw (unsynced) instead.
		hideLoadingOverlay();
	});

	// Only "error" was handled before - a clean server-initiated close (e.g.
	// the rate limiter disconnecting a flooding connection) fires "close",
	// not "error", so is_connected was never reset for that case.
	ws.addEventListener("close", () => {
		is_connected = false;
		hideLoadingOverlay();
	});

	initMultiplayerBridge(async (patch) => {
		// Registered before the (async) encoding below, not just before
		// send() - a remote patch applied during encoding counts as
		// interleaved too; see pending_own_patches above.
		pending_own_patches.set(patch.id, 0);
		const data = await blob_to_base64(patch.imageBlob);
		send({
			type: "patch",
			patch: {
				id: patch.id,
				toolId: patch.toolId,
				toolLabel: patch.toolLabel,
				timestamp: patch.timestamp,
				rect: patch.rect,
				canvasSize: patch.canvasSize,
				image: { mimeType: "image/png", data },
			},
		});
	});

	startBroadcastingCursor(send);
}

initMultiplayerClient();
