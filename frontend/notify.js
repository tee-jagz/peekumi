/**
 * @module Notifications: the bell on the Tasks page. When it is on, this device gets a
 * notification when an agent finishes a task or a session needs the owner, also while the app
 * is closed.
 *
 * Turning it on asks the browser for permission, subscribes the service worker to push with the
 * server's key (`GET /api/push/key`) and sends the subscription to the server
 * (`POST /api/push/subscribe`). Turning it off removes it on both sides
 * (`DELETE /api/push/subscribe`). The service worker (sw.js) shows a notification only when no
 * Peekumi window is on the screen. On an iPhone or iPad, push works only in the app that
 * "Add to Home Screen" makes; in Safari the bell says so.
 */
import { IconButton } from "./ui.js";

/** Makes the controller. `api(route, options)` sends a request and reads JSON; `notice(text,
 * error)` tells the owner what happened. */
export function createNotifications({ api, notice }) {
  const supported =
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  const apple =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  // "on", "off", "blocked" or "home" (an Apple device in Safari: add the app first).
  let state = supported ? "off" : "home";
  let busy = false;
  // The bell on the page now: the Tasks page draws a new one each time.
  let bell = null;

  /** The server key as bytes, for `pushManager.subscribe`. */
  const keyBytes = (key) =>
    Uint8Array.from(
      atob(
        key
          .replace(/-/g, "+")
          .replace(/_/g, "/")
          .padEnd(Math.ceil(key.length / 4) * 4, "="),
      ),
      (c) => c.charCodeAt(0),
    );
  const send = (method, body) =>
    api("/api/push/subscribe", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  function draw() {
    const words = {
      on: "Notifications are on. Turn them off",
      off: "Turn on notifications",
      blocked: "Notifications are blocked in the browser settings",
      home: "Notifications need the Home Screen app",
    }[state];
    if (!bell) return;
    const fresh = IconButton({
      icon: state === "on" ? "bell" : "bellOff",
      label: words,
      quiet: true,
      pressed: state === "on",
      disabled: busy,
      onClick: press,
    });
    fresh.id = "notifications";
    bell.replaceWith(fresh);
    bell = fresh;
  }

  /** Reads this device's state. A device with a subscription sends it again, so the server
   * knows it after a restore or a move to a new server. */
  async function read() {
    if (!supported) return;
    if (Notification.permission === "denied") state = "blocked";
    else {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      state =
        subscription && Notification.permission === "granted" ? "on" : "off";
      if (state === "on")
        await send("POST", subscription.toJSON()).catch(() => {});
    }
    draw();
  }

  async function turnOn() {
    if ((await Notification.requestPermission()) !== "granted") {
      state = Notification.permission === "denied" ? "blocked" : "off";
      return notice(
        "Peekumi cannot send notifications without your permission.",
        true,
      );
    }
    const registration = await navigator.serviceWorker.ready;
    // A subscription made with an older server key cannot be used again.
    await (await registration.pushManager.getSubscription())?.unsubscribe();
    const { key } = await api("/api/push/key");
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(key),
    });
    await send("POST", subscription.toJSON());
    state = "on";
    notice(
      "Notifications are on. This device tells you when an agent finishes or needs you.",
    );
  }

  async function turnOff() {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await send("DELETE", { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    }
    state = "off";
    notice("Notifications are off on this device.");
  }

  async function press() {
    if (state === "home")
      return notice(
        apple
          ? "On an iPhone or iPad, open Share, then Add to Home Screen. Open Peekumi from the Home Screen and turn on notifications there."
          : "This browser cannot get notifications from Peekumi. Open Peekumi over HTTPS in a browser that supports web push.",
      );
    if (state === "blocked")
      return notice(
        "Notifications are blocked. Allow them for this site in the browser settings, then try again.",
      );
    busy = true;
    draw();
    try {
      await (state === "on" ? turnOff() : turnOn());
    } catch (error) {
      notice(`Notifications: ${error.message}`, true);
    } finally {
      busy = false;
      draw();
    }
  }

  /** A bell button for a page header, or nothing on a browser that has no use for it. */
  function button() {
    if (!supported && !apple) return null;
    bell = IconButton({ icon: "bell", label: "Notifications", quiet: true });
    draw();
    return bell;
  }

  read().catch(() => {});
  return {
    button,
    /** True when this device gets notifications. */
    isOn: () => state === "on",
    /** True when this browser can turn notifications on (not blocked, not a Safari tab). */
    canTurnOn: () => state === "off",
    /** Turns notifications on, from a tap (the send sheet's "Tell me when it is done"). */
    async ensureOn() {
      if (state === "off") await press();
    },
  };
}
