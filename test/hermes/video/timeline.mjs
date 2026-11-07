/** @module Frame-based camera and cursor paths for the continuous native recording. */
export const FPS = 60;
export const ease = (value) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};
/** Sample a continuous camera path at a time in seconds. */
export function cameraAt(keys, seconds) {
  const right = keys.findIndex((key) => key.at > seconds);
  if (right < 0) return keys.at(-1);
  if (right === 0) return keys[0];
  const a = keys[right - 1],
    b = keys[right],
    t = ease((seconds - a.at) / (b.at - a.at));
  return {
    z: a.z + (b.z - a.z) * t,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}
/** Ease into the next recorded pointer target before its input time. */
export function pointerAt(actions, seconds) {
  const moves = actions.filter((action) => action.type === "move");
  if (!moves.length) return null;
  const next = moves.findIndex((action) => action.at > seconds);
  const b = next < 0 ? moves.at(-1) : moves[next];
  const a = next <= 0 ? (next === 0 ? b : moves.at(-1)) : moves[next - 1];
  const start = Math.max(a.at, b.at - 0.32);
  const t =
    next < 0 || b.at === start ? 1 : ease((seconds - start) / (b.at - start));
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
