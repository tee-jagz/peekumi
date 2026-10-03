/** @module Installable app shell with explicit updates and no offline repository storage. */
import { peek } from "./peek.js";
const notice = document.createElement("div");
notice.className = "pwa-notice";
notice.hidden = true;
notice.setAttribute("role", "status");
document.body.append(notice);
function connectivity() {
  if (!navigator.onLine) {
    notice.replaceChildren(
      peek("asleep"),
      document.createTextNode(
        "Offline · reconnect to your Peekumi server to inspect code.",
      ),
    );
    notice.className = "pwa-notice is-offline";
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
      /** Fills the card: Peek in `state`, a title, a line of detail and its actions. */
      function card(state, title, detail, actions = []) {
        const text = document.createElement("div");
        text.className = "pwa-text";
        const strong = document.createElement("strong");
        strong.textContent = title;
        const line = document.createElement("span");
        line.textContent = detail;
        text.append(strong, line);
        const buttons = document.createElement("div");
        buttons.className = "pwa-actions";
        for (const [label, primary, run] of actions) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = primary ? "btn primary" : "btn";
          b.textContent = label;
          b.onclick = run;
          buttons.append(b);
        }
        notice.className = "pwa-notice is-update";
        notice.replaceChildren(peek(state), text, ...(actions.length ? [buttons] : []));
        notice.hidden = false;
      }
      const later = () => (notice.hidden = true);
      const reload = () => {
        updateRequested = true;
        card("loading", "Updating Peekumi", "This takes a moment.");
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
        card("idle", "Peekumi has an update", "Reload to use the new version.", [
          ["Later", false, later],
          [
            "Reload",
            true,
            () =>
              unsent()
                ? card(
                    "thinking",
                    "You have unsent text",
                    "Reloading clears what you're typing. Your Ask conversation and saved instructions stay.",
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
