/** @module Installable app shell with explicit updates and no offline repository storage. */
import { HeaderNote } from "./ui.js";
// Offline and an update are quiet notes in the header's comparison row: a small Peek, a few
// words and plain text actions. They never cover the header.
let notice = null,
  noticeKind = null;
/** Shows a note of `kind` ("offline" or "update"), or none (`hide`). */
function show(kind, note) {
  notice?.remove();
  notice = kind ? HeaderNote({ kind, ...note }) : null;
  noticeKind = kind;
  if (notice)
    (document.querySelector(".title-block") || document.body).append(notice);
}
function connectivity() {
  if (!navigator.onLine)
    show("offline", {
      state: "asleep",
      text: "Offline",
      detail: "Reconnect to your Peekumi server to inspect code.",
    });
  // Back online: clear only the offline message, never an update waiting to be applied.
  else if (noticeKind === "offline") show(null);
}
window.addEventListener("offline", connectivity);
window.addEventListener("online", connectivity);
connectivity();
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker
    .register("/sw.js")
    .then((registration) => {
      let updateRequested = false;
      /** Fills the note: Peek in `state`, a few words, and its actions as plain text
       * buttons. `detail` is the note's tooltip. */
      function card(state, title, detail, actions = []) {
        show("update", {
          state,
          text: title,
          detail,
          actions: actions.map(([label, primary, onClick]) => ({
            label,
            primary,
            onClick,
          })),
        });
      }
      const later = () => show(null);
      const reload = () => {
        updateRequested = true;
        card("loading", "Updating", "This takes a moment.");
        registration.waiting?.postMessage("activate-update");
      };
      // Reloading clears anything typed but not yet sent; saved work is on the server.
      const unsent = () =>
        [...document.querySelectorAll("textarea, input[type=text]")].some((f) =>
          f.value.trim(),
        );
      function update() {
        if (!registration.waiting || !navigator.serviceWorker.controller)
          return;
        card(
          "idle",
          "Update ready",
          "Reload to use the new version of Peekumi.",
          [
            ["Later", false, later],
            [
              "Reload",
              true,
              () =>
                unsent()
                  ? card(
                      "thinking",
                      "Unsent text",
                      "Reloading clears what you type now. Your Ask conversation and saved instructions stay.",
                      [
                        ["Keep editing", false, later],
                        ["Reload anyway", true, reload],
                      ],
                    )
                  : reload(),
            ],
          ],
        );
      }
      update();
      registration.addEventListener("updatefound", () =>
        registration.installing?.addEventListener("statechange", update),
      );
      let reloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (
          navigator.serviceWorker.controller &&
          !reloading &&
          registration.active &&
          updateRequested
        ) {
          reloading = true;
          location.reload();
        }
      });
    })
    .catch(() => {
      /* Ordinary online browsing remains available if installation fails. */
    });
}
