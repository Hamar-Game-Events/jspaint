// @ts-check
/* global pointer, pointer_over_canvas */
import { $DialogWindow } from "./$ToolWindow.js";
import { $G, E, from_canvas_coords } from "./helpers.js";
// Generated from images/cursors/multiplayer/ at dev/install time - see
// scripts/generate-cursor-images-manifest.js. Not checked in (per
// .gitignore); run `npm install` or `npm run dev` if this import 404s.
import { CURSOR_IMAGES } from "./multiplayer-cursor-images.js";

export const CURSOR_IMAGE_DIR = "images/cursors/multiplayer/";
const DEFAULT_CURSOR_IMAGE = CURSOR_IMAGES.includes("thisisfine.gif") ? "thisisfine.gif" : CURSOR_IMAGES[0];
const CURSOR_DISPLAY_SIZE = 40; // px on screen; native sizes vary per image
const LOCAL_STORAGE_KEY = "jspaint multiplayer cursor image";

// How often we broadcast our own position, at most. Browsers can fire
// pointermove far faster than this; there's no reason to spend a websocket
// message per tick when nobody's eye can tell 10/sec from 120/sec. Each
// message is a billed Durable Object request, so this directly trades
// smoothness for cost - see MIN_BROADCAST_DISTANCE below too.
const BROADCAST_INTERVAL_MS = 100;

// Skip sending if the pointer has barely moved since the last broadcast -
// sub-pixel jitter while holding the mouse still would otherwise still
// trigger a message every tick.
const MIN_BROADCAST_DISTANCE = 3;

/** @type {Map<string, {el: HTMLImageElement, image: string}>} */
const remote_cursors = new Map();

/**
 * @param {string} id
 * @param {string} image
 * @returns {HTMLImageElement}
 */
function get_or_create_cursor_element(id, image) {
	let entry = remote_cursors.get(id);
	if (entry) {
		if (entry.image !== image) {
			entry.image = image;
			entry.el.src = CURSOR_IMAGE_DIR + image;
		}
		return entry.el;
	}
	const el = /** @type {HTMLImageElement} */ (E("img"));
	el.src = CURSOR_IMAGE_DIR + image;
	el.alt = "";
	el.style.position = "fixed";
	el.style.zIndex = "10000";
	el.style.width = `${CURSOR_DISPLAY_SIZE}px`;
	el.style.height = "auto";
	el.style.pointerEvents = "none";
	// Centers the image on the tracked point, rather than treating its
	// top-left corner as the hotspot like a normal cursor image would.
	el.style.transform = "translate(-50%, -50%)";
	document.body.appendChild(el);
	remote_cursors.set(id, { el, image });
	return el;
}

/**
 * @param {string} id
 * @param {number} x - canvas-space, not viewport pixels
 * @param {number} y
 * @param {string} [image] - filename under images/cursors/multiplayer/;
 *   falls back to whatever this id last used, or the default.
 */
export function showRemoteCursor(id, x, y, image) {
	const resolved_image = image ?? remote_cursors.get(id)?.image ?? DEFAULT_CURSOR_IMAGE;
	const el = get_or_create_cursor_element(id, resolved_image);
	const { clientX, clientY } = from_canvas_coords({ x, y });
	el.style.left = `${clientX}px`;
	el.style.top = `${clientY}px`;
}

/** @param {string} id */
export function hideRemoteCursor(id) {
	const entry = remote_cursors.get(id);
	if (entry) {
		entry.el.remove();
		remote_cursors.delete(id);
	}
}

/** @returns {string} */
function read_local_cursor_image() {
	try {
		const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
		if (stored && CURSOR_IMAGES.includes(stored)) { return stored; }
	} catch (_error) { /* ignore */ }
	return DEFAULT_CURSOR_IMAGE;
}

let local_cursor_image = read_local_cursor_image();
/** @type {((message: object) => void) | null} */
let send_cursor_update = null;

/**
 * @param {string} image
 */
export function setLocalCursorImage(image) {
	if (!CURSOR_IMAGES.includes(image)) { return; }
	local_cursor_image = image;
	try {
		localStorage.setItem(LOCAL_STORAGE_KEY, image);
	} catch (_error) { /* ignore */ }
	// Only push it out immediately if others can currently see us at all -
	// otherwise this would make our cursor reappear (at a stale position)
	// for everyone even though we've left the canvas. If we're not over it
	// right now, the next position broadcast after we return already
	// includes whatever's currently selected, so nothing is lost.
	if (pointer_over_canvas && send_cursor_update) {
		send_cursor_update({ type: "cursor", x: pointer.x, y: pointer.y, image: local_cursor_image });
	}
	// So any UI showing the current selection (e.g. the toolbox preview) can
	// update itself, regardless of which UI (this picker, or another one)
	// made the change.
	$G.trigger("cursor-image-changed", [local_cursor_image]);
}

export function getLocalCursorImage() {
	return local_cursor_image;
}

export function getAvailableCursorImages() {
	return CURSOR_IMAGES;
}

/**
 * Starts broadcasting the local pointer's canvas-space position (while it's
 * over the canvas) at a fixed interval, via `send`. Doesn't touch incoming
 * messages at all - wire showRemoteCursor/hideRemoteCursor up to those
 * yourself (see multiplayer-client.js).
 * @param {(message: object) => void} send
 */
export function startBroadcastingCursor(send) {
	send_cursor_update = send;
	let last_sent = { x: NaN, y: NaN };
	let was_over_canvas = false;

	setInterval(() => {
		if (pointer_over_canvas) {
			const distance = Math.hypot(pointer.x - last_sent.x, pointer.y - last_sent.y);
			if (Number.isNaN(distance) || distance >= MIN_BROADCAST_DISTANCE) {
				last_sent = { x: pointer.x, y: pointer.y };
				send({ type: "cursor", x: pointer.x, y: pointer.y, image: local_cursor_image });
			}
		} else if (was_over_canvas) {
			// Only send once, right as it leaves - not on every tick while
			// it's away, which would just be noise.
			send({ type: "cursor-left" });
		}
		was_over_canvas = pointer_over_canvas;
	}, BROADCAST_INTERVAL_MS);
}

/**
 * Opens a dialog to pick which image represents your cursor to everyone
 * else. Clicking a thumbnail selects it immediately (like picking a theme),
 * rather than needing a separate confirm button.
 */
export function showCursorImagePicker() {
	const $w = $DialogWindow();
	$w.title("Choose Cursor Image");
	$w.$main.css({ maxWidth: "300px" });

	const $grid = $(E("div")).css({
		display: "flex",
		flexWrap: "wrap",
		gap: "6px",
		justifyContent: "center",
	}).appendTo($w.$main);

	/** @type {Record<string, HTMLElement>} */
	const buttons = {};
	for (const image of CURSOR_IMAGES) {
		const $button = $(E("button")).addClass("toggle").css({
			width: "56px",
			height: "56px",
			padding: "2px",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
		}).appendTo($grid);
		$(E("img")).attr({ src: CURSOR_IMAGE_DIR + image, alt: image, title: image }).css({
			maxWidth: "100%",
			maxHeight: "100%",
		}).appendTo($button);
		buttons[image] = $button[0];

		$button.on("click", () => {
			setLocalCursorImage(image);
			for (const [other_image, el] of Object.entries(buttons)) {
				el.classList.toggle("selected", other_image === image);
			}
		});
	}
	buttons[local_cursor_image]?.classList.add("selected");

	$w.$Button("Close", () => {
		$w.close();
	}, { type: "submit" }).focus();

	$w.center();
}
