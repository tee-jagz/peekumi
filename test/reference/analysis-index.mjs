import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";

// Store syntax-only analysis. Resolved imports belong to a snapshot, not a blob.
export class AnalysisIndex {
  constructor(directory, namespace) {
    this.memory = new Map();
    this.pending = new Map();
    if (!directory) return;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, namespace + ".sqlite");
      this.db = new DatabaseSync(file);
      chmodSync(file, 0o600);
      this.db.exec(
        "PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS analysis (key TEXT PRIMARY KEY, data TEXT NOT NULL)",
      );
      this.read = this.db.prepare("SELECT data FROM analysis WHERE key = ?");
      this.write = this.db.prepare(
        "INSERT OR REPLACE INTO analysis(key,data) VALUES (?,?)",
      );
    } catch (error) {
      this.disable(error);
    }
  }
  disable(error) {
    console.warn(
      "Peekumi index unavailable; using memory cache:",
      error.message,
    );
    try {
      this.db?.close();
    } catch {}
    this.db = null;
    this.read = null;
    this.write = null;
    this.pending.clear();
  }
  get(key) {
    let data = this.memory.get(key);
    try {
      data ||= this.read?.get(key)?.data;
    } catch (error) {
      this.disable(error);
    }
    try {
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }
  set(key, value) {
    const data = JSON.stringify(value);
    this.memory.set(key, data);
    if (this.memory.size > 4000)
      this.memory.delete(this.memory.keys().next().value);
    if (this.db) this.pending.set(key, data);
  }
  flush() {
    if (!this.db || !this.pending.size) return;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      for (const [key, data] of this.pending) this.write.run(key, data);
      // Bound stored payload to 128 MiB; old parser versions are evicted first.
      let bytes = this.db
        .prepare(
          "SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) AS bytes FROM analysis",
        )
        .get().bytes;
      if (bytes > 128 * 1024 * 1024) {
        const remove = this.db.prepare("DELETE FROM analysis WHERE key = ?");
        for (const row of this.db
          .prepare(
            "SELECT key, length(CAST(data AS BLOB)) AS bytes FROM analysis ORDER BY rowid",
          )
          .all()) {
          remove.run(row.key);
          bytes -= row.bytes;
          if (bytes <= 128 * 1024 * 1024) break;
        }
      }
      this.db.exec("COMMIT");
      this.pending.clear();
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      this.disable(error);
    }
  }
  close() {
    this.flush();
    this.db?.close();
  }
}
