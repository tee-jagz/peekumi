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
      peek("error"),
      document.createTextNode(
        "Offline · reconnect to your Peekumi server to inspect code.",
      ),
    );
    notice.classList.add("is-offline");
    notice.hidden = false;
  } else {
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
      function update() {
        if (!registration.waiting || !navigator.serviceWorker.controller)
          return;
        const action = document.createElement("button");
        action.textContent = "Update available · reload";
        action.onclick = () => {
          if (confirm("Save any unsent drafts before updating. Reload now?")) {
            updateRequested = true;
            registration.waiting.postMessage("activate-update");
          }
        };
        notice.replaceChildren(action);
        notice.hidden = false;
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
