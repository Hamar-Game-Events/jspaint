// @ts-check
/* global current_history_node:writable, main_canvas, main_ctx, selected_tool */
import { $G, make_canvas } from "./helpers.js";

/**
 * The shape of one committed jspaint action, ready to hand to a transport
 * (e.g. a PartyKit client) which will base64-encode `imageBlob` (or send it
 * as-is over a binary websocket message) before it goes over the wire.
 *
 * Storage/wire form (what a server persists and replays to new joiners):
 * {
 *   id: string,               // uuid, assigned client-side
 *   roomId: string,           // assigned by the transport, not this module
 *   userId: string,           // assigned by the server on connect, not this module
 *   seq: number,              // assigned by the server, for ordering/replay
 *   createdAt: number,        // ms epoch, server-assigned authoritative time
 *   toolId: string,           // stable tool id, e.g. "TOOL_ERASER" - what permission checks gate on
 *   toolLabel: string,        // localized display name, for history/audit UI only
 *   rect: {x, y, w, h},       // bounding box of changed pixels, canvas coordinate space
 *   canvasSize: {width, height},
 *   image: { mimeType: "image/png", data: string }, // data is base64
 * }
 *
 * @typedef {object} StrokePatch
 * @property {string} id
 * @property {string | null} toolId
 * @property {string} toolLabel
 * @property {number} timestamp
 * @property {{x: number, y: number, w: number, h: number}} rect - the whole
 *   changed area, or one tile of it if the change was too big to encode as a
 *   single patch (see crop_to_png_tiles) - either way, a complete, standalone
 *   patch that doesn't depend on any other patch to make sense.
 * @property {{width: number, height: number}} canvasSize
 * @property {Blob} imageBlob - PNG-encoded pixels for just `rect`, not the whole canvas
 */

/**
 * Finds the smallest rectangle containing every differing pixel between two
 * same-sized ImageData buffers. Returns null if they're identical.
 * @param {ImageData} before
 * @param {ImageData} after
 * @returns {{x: number, y: number, w: number, h: number} | null}
 */
function diff_bounding_rect(before, after) {
	const { width, height } = after;
	const a = before.data;
	const b = after.data;
	let min_x = width, min_y = height, max_x = -1, max_y = -1;
	for (let y = 0; y < height; y++) {
		const row_offset = y * width * 4;
		for (let x = 0; x < width; x++) {
			const i = row_offset + x * 4;
			if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
				if (x < min_x) { min_x = x; }
				if (x > max_x) { max_x = x; }
				if (y < min_y) { min_y = y; }
				if (y > max_y) { max_y = y; }
			}
		}
	}
	if (max_x < 0) { return null; }
	return { x: min_x, y: min_y, w: max_x - min_x + 1, h: max_y - min_y + 1 };
}

/**
 * Crops `after` to `rect`, but forces any pixel identical to `before` at that
 * position fully transparent - so compositing this onto a receiver's canvas
 * (a plain alpha-aware drawImage, unchanged - see multiplayer-client.js) only
 * touches pixels this stroke actually changed, instead of opaquely
 * overwriting everything in the bounding rect. Without this, a stroke whose
 * bounding rect happens to overlap someone else's unrelated drawing would
 * silently erase it, since PNG patches had no transparency at all before.
 * @param {ImageData} before
 * @param {ImageData} after
 * @param {{x: number, y: number, w: number, h: number}} rect
 * @returns {ImageData}
 */
function build_masked_image_data(before, after, rect) {
	const out = new ImageData(rect.w, rect.h);
	const a = before.data, b = after.data;
	const src_width = after.width;
	for (let y = 0; y < rect.h; y++) {
		const src_row = (rect.y + y) * src_width * 4;
		const out_row = y * rect.w * 4;
		for (let x = 0; x < rect.w; x++) {
			const src_i = src_row + (rect.x + x) * 4;
			const out_i = out_row + x * 4;
			if (a[src_i] !== b[src_i] || a[src_i + 1] !== b[src_i + 1] || a[src_i + 2] !== b[src_i + 2] || a[src_i + 3] !== b[src_i + 3]) {
				out.data[out_i] = b[src_i];
				out.data[out_i + 1] = b[src_i + 1];
				out.data[out_i + 2] = b[src_i + 2];
				out.data[out_i + 3] = b[src_i + 3];
			}
			// else leave as (0, 0, 0, 0) - ImageData is zero-initialized, i.e.
			// fully transparent, which is exactly "unchanged" here.
		}
	}
	return out;
}

/**
 * Slices a sub-rect out of a masked ImageData buffer - `full`'s own origin is
 * `full_rect.x/y` in the same coordinate space `sub_rect` is expressed in.
 * @param {ImageData} full
 * @param {{x: number, y: number, w: number, h: number}} full_rect
 * @param {{x: number, y: number, w: number, h: number}} sub_rect
 * @returns {ImageData}
 */
function extract_sub_image_data(full, full_rect, sub_rect) {
	const out = new ImageData(sub_rect.w, sub_rect.h);
	const local_x = sub_rect.x - full_rect.x;
	const local_y = sub_rect.y - full_rect.y;
	for (let y = 0; y < sub_rect.h; y++) {
		const src_row = ((local_y + y) * full_rect.w + local_x) * 4;
		const out_row = y * sub_rect.w * 4;
		out.data.set(full.data.subarray(src_row, src_row + sub_rect.w * 4), out_row);
	}
	return out;
}

/**
 * @param {ImageData} image_data
 * @returns {Promise<Blob>}
 */
function image_data_to_png_blob(image_data) {
	const cropped = make_canvas(image_data.width, image_data.height);
	cropped.ctx.putImageData(image_data, 0, 0);
	return new Promise((resolve, reject) => {
		cropped.toBlob((blob) => {
			if (blob) {
				resolve(blob);
			} else {
				reject(new Error("toBlob returned null"));
			}
		}, "image/png");
	});
}

// A patch's PNG, once base64-encoded and wrapped in its JSON envelope, has to
// fit in one Durable Object storage value on the server (a hard 128 KiB
// limit) - see partykit/src/server.ts's own backstop check. Base64 inflates
// raw bytes by ~4/3, so this leaves comfortable room under that limit even
// with JSON overhead on top. Picked well below the ceiling rather than
// against it, since PNG size isn't perfectly predictable ahead of encoding.
const MAX_TILE_BLOB_BYTES = 85 * 1024;
// Stop splitting at this size regardless of blob size, so pathological
// (incompressible) content can't recurse forever - a tile this small is
// nowhere near the byte limit even in the worst case (64*64*4 bytes raw
// RGBA, before any PNG compression, is ~16 KiB).
const MIN_TILE_SIZE = 64;

/**
 * Splits `full_rect`'s masked pixels into a grid of smaller rects (each
 * encoded separately) if the whole thing wouldn't fit in one stored patch.
 * Ordinary strokes are small enough that this never splits - it only matters
 * for something like an admin flood-filling a large area of an 8K canvas in
 * one action.
 * @param {ImageData} full_masked_image_data
 * @param {{x: number, y: number, w: number, h: number}} full_rect
 * @param {{x: number, y: number, w: number, h: number}} rect
 * @returns {Promise<Array<{rect: {x: number, y: number, w: number, h: number}, blob: Blob}>>}
 */
async function crop_to_png_tiles(full_masked_image_data, full_rect, rect) {
	const sub = rect === full_rect ? full_masked_image_data : extract_sub_image_data(full_masked_image_data, full_rect, rect);
	const blob = await image_data_to_png_blob(sub);
	if (blob.size <= MAX_TILE_BLOB_BYTES || (rect.w <= MIN_TILE_SIZE && rect.h <= MIN_TILE_SIZE)) {
		return [{ rect, blob }];
	}
	// Split along the longer side, so repeated splitting converges on
	// roughly square tiles rather than ever-thinner slivers.
	if (rect.w >= rect.h) {
		const left_w = Math.max(1, Math.floor(rect.w / 2));
		const left = { x: rect.x, y: rect.y, w: left_w, h: rect.h };
		const right = { x: rect.x + left_w, y: rect.y, w: rect.w - left_w, h: rect.h };
		return [...await crop_to_png_tiles(full_masked_image_data, full_rect, left), ...await crop_to_png_tiles(full_masked_image_data, full_rect, right)];
	} else {
		const top_h = Math.max(1, Math.floor(rect.h / 2));
		const top = { x: rect.x, y: rect.y, w: rect.w, h: top_h };
		const bottom = { x: rect.x, y: rect.y + top_h, w: rect.w, h: rect.h - top_h };
		return [...await crop_to_png_tiles(full_masked_image_data, full_rect, top), ...await crop_to_png_tiles(full_masked_image_data, full_rect, bottom)];
	}
}

// Keyed on the *ImageData object*, not the history node itself: undo/redo
// revisit an existing node without ever calling getImageData again, so its
// image_data reference is unchanged and gets skipped as "already seen". A
// node whose snapshot is regenerated in place (make_or_update_undoable, used
// for continuous adjustments to a not-yet-finalized action) gets a new
// ImageData object each time and is correctly treated as a fresh update.
const seen_image_data = new WeakSet();

/**
 * Starts listening for locally-committed jspaint actions (one call per
 * pencil stroke, shape, fill, paste, etc. - whatever triggers `undoable()`)
 * and reports each as a small patch containing only the pixels that changed.
 *
 * This does not talk to the network - it just produces patches. Wire them up
 * to a transport (PartyKit client) to actually sync them between users, and
 * do permission checks (e.g. rejecting eraser patches from non-admins) there
 * or on the server, using `toolId`.
 *
 * @param {(patch: StrokePatch) => void} onPatch
 */
export function initMultiplayerBridge(onPatch) {
	if (current_history_node.image_data) {
		seen_image_data.add(current_history_node.image_data);
	}

	$G.on("history-update.multiplayer-bridge", async () => {
		const node = current_history_node;

		// "soft" nodes (e.g. making a selection) don't change canvas pixels.
		if (node.soft) { return; }
		if (!node.parent || !node.image_data || !node.parent.image_data) { return; }
		// Undo/redo/history-window navigation revisit a node we've already
		// broadcast (or the root) rather than producing a new snapshot.
		if (seen_image_data.has(node.image_data)) { return; }
		seen_image_data.add(node.image_data);

		const rect = diff_bounding_rect(node.parent.image_data, node.image_data);
		if (!rect) { return; } // nothing actually changed

		const masked_image_data = build_masked_image_data(node.parent.image_data, node.image_data, rect);

		// Usually just one tile (the whole rect) - see crop_to_png_tiles.
		// Each tile becomes its own fully independent patch (own id, own
		// rect), so nothing downstream needs to know splitting happened.
		const tiles = await crop_to_png_tiles(masked_image_data, rect, rect);
		const canvasSize = { width: main_canvas.width, height: main_canvas.height };
		for (const tile of tiles) {
			onPatch({
				id: crypto.randomUUID(),
				toolId: selected_tool?.id ?? null,
				toolLabel: node.name,
				timestamp: node.timestamp,
				rect: tile.rect,
				canvasSize,
				imageBlob: tile.blob,
			});
		}
	});
}

/**
 * Call this after drawing a remote patch onto the canvas (multiplayer-client.js's
 * job, since applying a remote patch deliberately bypasses undoable() - see
 * that file for why). Without this, `current_history_node.image_data` keeps
 * pointing at a snapshot from before the remote patch, so the next locally
 * committed action would get diffed against stale "before" pixels: any
 * region a remote patch touched would look unchanged even after a real local
 * edit there, silently dropping that part of the diff (or the whole patch,
 * if that was the only region touched).
 */
export function noteExternalCanvasChange() {
	current_history_node.image_data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
}

export function stopMultiplayerBridge() {
	$G.off(".multiplayer-bridge");
}
