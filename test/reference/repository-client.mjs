import { Worker } from "node:worker_threads";
import path from "node:path";
export class RepositoryClient {
  constructor(directory, options = {}) {
    this.directory = path.resolve(directory);
    this.pending = new Map();
    this.sequence = 0;
    this.worker = new Worker(
      new URL("./repository-worker.mjs", import.meta.url),
      { workerData: { directory: this.directory, options } },
    );
    this.worker.on("message", ({ id, result, error }) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      error ? pending.reject(Error(error)) : pending.resolve(result);
    });
    const fail = (error) => {
      this.failure = error;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    this.worker.on("error", fail);
    this.worker.on("exit", (code) =>
      fail(Error("Repository worker stopped (" + code + ")")),
    );
  }
  call(method, args) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, args });
    });
  }
  resolve(...args) {
    return this.call("resolve", args);
  }
  metadata(...args) {
    return this.call("metadata", args);
  }
  compare(...args) {
    return this.call("compare", args);
  }
  source(...args) {
    return this.call("source", args);
  }
  metrics() {
    return this.call("metrics", []);
  }
  close() {
    return this.worker.terminate();
  }
}
