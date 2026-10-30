// @ts-check
/* global main_ctx */

// A picture every shared canvas starts with, so a new room never looks empty.
// Drop a PNG at WATERMARK_PATH to use it; without one, rooms start blank.
//
// It's drawn locally by every client under the room's patches, never sent to
// the server: patches only carry the pixels a stroke changed (transparent
// elsewhere), so strokes cover it while the rest of it shows through. That
// also means swapping the image changes it in every room, old ones included.
//
// Scaled to WATERMARK_HEIGHT (keeping its proportions) in the top-left
// corner, drawn as-is - fade it in the image itself if it should look like a
// watermark. Same-origin, so the canvas isn't tainted (a cross-origin image
// would break toBlob() for patches).
const WATERMARK_PATH = "images/multiplayer-watermark.png";
const WATERMARK_HEIGHT = 500;
// Gap to the canvas's top and left edges.
const WATERMARK_MARGIN = 40;

/** @type {Promise<HTMLImageElement | null> | null} */
let loading = null;

/**
 * Starts loading the image (once). Call early, so it's usually ready by the
 * time the room's history arrives.
 * @returns {Promise<HTMLImageElement | null>} null if there's no watermark
 */
export function loadWatermark() {
	loading ??= new Promise((resolve) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => resolve(null);
		image.src = WATERMARK_PATH;
	});
	return loading;
}

/**
 * Draws the watermark onto the canvas, bypassing undoable()/history like a
 * remote patch (see apply_patch_to_canvas). Call before applying the room's
 * history, on the fresh canvas.
 */
export async function drawWatermark() {
	const image = await loadWatermark();
	if (!image) { return; }
	const height = WATERMARK_HEIGHT;
	const width = Math.round(image.naturalWidth * (height / image.naturalHeight));
	main_ctx.drawImage(image, WATERMARK_MARGIN, WATERMARK_MARGIN, width, height);
}
