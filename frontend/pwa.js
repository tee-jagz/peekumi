/** @module Installable app shell with explicit updates and no offline repository storage. */
import { peek } from "./peek.js";
// Offline and an update are quiet notes in the header's comparison row: a small Peek, a few
// words and plain text actions. They never cover the header.
const notice = document.createElement("span");
notice.className = "app-note";
notice.hidden = true;
notice.setAttribute("role", "status");
(document.querySelector(".title-block") || document.body).append(notice);
function connectivity() {
  if (!navigator.onLine) {
    notice.replaceChildren(peek("asleep"), document.createTextNode("Offline"));
    notice.title = "Reconnect to your Peekumi server to inspect code.";
    notice.className = "app-note is-offline";
    notice.hidden = false;
  } else if (notice.classList.contains("is-offline")) {
    // Back online: clear only the offline message, never an update waiting to be applied.
    notice.classList.remove("is-offline");
    notice.hidden = true;
  }
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
        const buttons = actions.map(([label, primary, run]) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = primary ? "app-note-action is-main" : "app-note-action";
          b.textContent = label;
          b.onclick = run;
          return b;
        });
        notice.className = "app-note is-update";
        notice.title = detail;
        notice.replaceChildren(peek(state), document.createTextNode(title), ...buttons);
        notice.hidden = false;
      }
      const later = () => (notice.hidden = true);
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
        card("idle", "Update ready", "Reload to use the new version of Peekumi.", [
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
        ]);
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
