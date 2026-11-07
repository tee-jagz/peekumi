/** @module Check motion continuity and cursor agreement with actual input events. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cameraAt, pointerAt } from "./timeline.mjs";
test("camera stays continuous across a held shot and a pan", () => {
  const keys = [
    { at: 0, x: 800, y: 500, z: 1 },
    { at: 2, x: 980, y: 400, z: 1.28 },
    { at: 5, x: 980, y: 400, z: 1.28 },
    { at: 6.4, x: 540, y: 520, z: 1.48 },
  ];
  let previous = cameraAt(keys, 0),
    velocity = { x: 0, y: 0 };
  for (let frame = 1; frame <= 6.4 * 60; frame++) {
    const camera = cameraAt(keys, frame / 60),
      next = { x: camera.x - previous.x, y: camera.y - previous.y };
    assert.ok(
      Math.abs(next.x - velocity.x) < 0.8 &&
        Math.abs(next.y - velocity.y) < 0.8,
      "The camera must accelerate smoothly instead of stepping between integer positions",
    );
    assert.ok(Math.abs(camera.z - previous.z) < 0.01, "No sudden zoom");
    previous = camera;
    velocity = next;
  }
  assert.deepEqual(cameraAt(keys, 3), { z: 1.28, x: 980, y: 400 });
  assert.equal(cameraAt(keys, 8).x, 540);
});
test("cursor arrives at the real click without jumping early", () => {
  const actions = [
    { at: 1, type: "move", x: 100, y: 100 },
    { at: 3, type: "move", x: 600, y: 350 },
    { at: 3.02, type: "click", x: 600, y: 350 },
  ];
  assert.deepEqual(pointerAt(actions, 2), { x: 100, y: 100 });
  const moving = pointerAt(actions, 2.84);
  assert.ok(moving.x > 100 && moving.x < 600);
  assert.deepEqual(pointerAt(actions, 3.02), { x: 600, y: 350 });
});
