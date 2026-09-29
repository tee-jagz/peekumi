import { parentPort, workerData } from "node:worker_threads";
import { Repository } from "./engine.mjs";
const repo = new Repository(workerData.directory, workerData.options);
const methods = new Set([
  "resolve",
  "metadata",
  "compare",
  "source",
  "metrics",
]);
parentPort.on("message", async ({ id, method, args }) => {
  try {
    if (!methods.has(method)) throw Error("Unknown repository operation");
    parentPort.postMessage({ id, result: await repo[method](...args) });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
