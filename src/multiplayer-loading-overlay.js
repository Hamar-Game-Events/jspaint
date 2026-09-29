// @ts-check
import { E } from "./helpers.js";
import { CURSOR_IMAGE_DIR } from "./multiplayer-cursors.js";

/** @type {JQuery<HTMLDivElement> | undefined} */
let $overlay;

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
	$overlay = /** @type {JQuery<HTMLDivElement>} */ ($(E("div")).addClass("multiplayer-loading-overlay"));
	$(E("img")).attr({ src: `${CURSOR_IMAGE_DIR}tama.gif`, alt: "" }).addClass("multiplayer-loading-spinner").appendTo($overlay);
	attach_when_canvas_area_ready();
}

// initMultiplayerClient() runs at module-eval time, before jspaint's own
// startup (session-from-URL loading etc. in sessions.js) has settled - at
// that point window.$canvas_area can be a reference that's about to be
// discarded and rebuilt, so appending straight to it here would silently
// end up in a detached subtree. Retry each frame until the real, final
// $canvas_area is actually in the document before inserting into it.
function attach_when_canvas_area_ready() {
	if (!$overlay) { return; } // hidden again before we got a chance to attach it
	if (document.body.contains(window.$canvas_area?.[0])) {
		$overlay.appendTo(window.$canvas_area);
	} else {
		requestAnimationFrame(attach_when_canvas_area_ready);
	}
}

export function hideLoadingOverlay() {
	$overlay?.remove();
	$overlay = undefined;
}
