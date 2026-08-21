// Persists alert rule config, per-asset limits, and recipient lists to a
// single JSON file so settings survive restarts and redeploys.
//
// Precedence on boot: saved file > .env values > code defaults.
// Writes are debounced and atomic (write to *.tmp, then rename) to avoid
// torn files if the process exits mid-write.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..", "..");

const DEFAULT_FILE = path.join(backendRoot, "data", "alerts-state.json");
const DEBOUNCE_MS = 400;

export class AlertStateStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath || process.env.ALERT_STATE_FILE || DEFAULT_FILE;
    this._pending = null;
    this._timer = null;
    this._snapshot = { config: {}, assetLimits: {}, subscribers: null };
    this.fileExists = false;
  }

  // Loaded snapshot. Fields are undefined/null when the file is missing OR
  // the field was absent in the file, so callers can apply their own
  // fallback (env / code default) rather than treating "empty" as "saved".
  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this._snapshot = {
        config: parsed.config && typeof parsed.config === "object" ? parsed.config : {},
        assetLimits:
          parsed.assetLimits && typeof parsed.assetLimits === "object" ? parsed.assetLimits : {},
        subscribers:
          parsed.subscribers && typeof parsed.subscribers === "object"
            ? {
                emails: Array.isArray(parsed.subscribers.emails) ? parsed.subscribers.emails : [],
                whatsapp: Array.isArray(parsed.subscribers.whatsapp)
                  ? parsed.subscribers.whatsapp
                  : []
              }
            : null
      };
      this.fileExists = true;
    } catch (err) {
      if (err.code !== "ENOENT") {
        // eslint-disable-next-line no-console
        console.warn(`[AlertStateStore] Could not load ${this.filePath}: ${err.message}`);
      }
      this._snapshot = { config: {}, assetLimits: {}, subscribers: null };
      this.fileExists = false;
    }
    return this._snapshot;
  }

  getSnapshot() {
    return this._snapshot;
  }

  // Merge a partial update into the snapshot and schedule a debounced write.
  // Callers may pass any subset of { config, assetLimits, subscribers }.
  update(patch) {
    if (patch.config) {
      this._snapshot.config = { ...this._snapshot.config, ...patch.config };
    }
    if (patch.assetLimits) {
      this._snapshot.assetLimits = patch.assetLimits;
    }
    if (patch.subscribers) {
      this._snapshot.subscribers = {
        emails: [...(patch.subscribers.emails || [])],
        whatsapp: [...(patch.subscribers.whatsapp || [])]
      };
    }
    this._scheduleWrite();
  }

  _scheduleWrite() {
    this._pending = this._snapshot;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._flush();
    }, DEBOUNCE_MS);
  }

  _flush() {
    const data = this._pending;
    this._pending = null;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[AlertStateStore] Write failed (${this.filePath}): ${err.message}`);
    }
  }

  // Synchronous final flush — call on shutdown if needed.
  flushSync() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._pending) this._flush();
  }
}
