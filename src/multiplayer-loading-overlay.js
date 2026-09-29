// @ts-check
import { E } from "./helpers.js";
import { CURSOR_IMAGE_DIR } from "./multiplayer-cursors.js";

/** @type {JQuery<HTMLDivElement> | undefined} */
let $overlay;
/** @type {(() => void) | undefined} */
let stop_tracking_position;

/**
 * Blurs the canvas and blocks drawing input until hideLoadingOverlay() is
 * called. Shown for the whole connect-and-replay-history window, so a
 * visitor never gets even a glimpse of whatever's already on the shared
 * canvas (could be something offensive someone drew before moderation
 * caught it) while it's being redrawn, and can't draw into a canvas that
 * isn't fully populated yet.
 */
export function showLoadingOverlay() {
	if ($overlay) { return; }
	$overlay = /** @type {JQuery<HTMLDivElement>} */ ($(E("div")).addClass("multiplayer-loading-overlay").appendTo(document.body));
	$(E("img")).attr({ src: `${CURSOR_IMAGE_DIR}tama.gif`, alt: "" }).addClass("multiplayer-loading-spinner").appendTo($overlay);
	track_canvas_area_position();
}

/**
 * Fixed-positioned and kept in sync with $canvas_area's own on-screen rect,
 * rather than being a normal child of it. $canvas_area is scrollable (the
 * canvas is much bigger than its viewport), and a child positioned with
 * inset:0 only ever covers that box's un-scrolled top-left corner - once
 * the user scrolls, the canvas outside that corner would show through
 * unblurred, defeating the whole point of hiding it. This also sidesteps
 * $canvas_area not being attached to the document yet when this first
 * runs (the jspaint startup race the retry loop below waits out).
 */
function track_canvas_area_position() {
	if (!$overlay) { return; } // hidden again before this got a chance to run
	const canvas_area = window.$canvas_area?.[0];
	if (!canvas_area || !document.body.contains(canvas_area)) {
		requestAnimationFrame(track_canvas_area_position);
		return;
	}
	const sync_position = () => {
		const rect = canvas_area.getBoundingClientRect();
		$overlay?.css({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
	};
	sync_position();
	canvas_area.addEventListener("scroll", sync_position);
	window.addEventListener("resize", sync_position);
	const resize_observer = new ResizeObserver(sync_position);
	resize_observer.observe(canvas_area);
	stop_tracking_position = () => {
		canvas_area.removeEventListener("scroll", sync_position);
		window.removeEventListener("resize", sync_position);
		resize_observer.disconnect();
	};
}

export function hideLoadingOverlay() {
	stop_tracking_position?.();
	stop_tracking_position = undefined;
	$overlay?.remove();
	$overlay = undefined;
}
