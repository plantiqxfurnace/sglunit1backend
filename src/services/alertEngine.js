// Stateful per-asset alert engine.
//
// Two independent rule families, always evaluated on every live record:
//
//   1) Deviation rules
//      - overheat  : (mv - sp) > thresholdDeg sustained for sustainMinutes
//      - undercool : (sp - mv) > thresholdLowDeg sustained for sustainMinutes  (optional)
//      Requires a valid SP on the record; cleared if SP is missing.
//
//   2) Absolute band rules (per-furnace high/low limits)
//      - high_limit : mv > assetLimit.high sustained for sustainMinutes
//      - low_limit  : mv < assetLimit.low sustained for sustainMinutes
//
// Cooldown prevents re-notifying for the same condition within cooldownMinutes.
// Each (deviceId, kind) tuple has its own breach window so e.g. overheat and
// high_limit can fire independently without clobbering each other.

const ALERT_HISTORY_MAX = 200;

const fmtDeg = (n) => (typeof n === "number" ? `${n.toFixed(1)}°C` : "—");

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

const pickNum = (saved, fallback) => {
  const n = Number(saved);
  return Number.isFinite(n) ? n : fallback;
};

const pickBool = (saved, fallback) =>
  typeof saved === "boolean" ? saved : fallback;

export class AlertEngine {
  constructor({ env, store, io, notifier, stateStore }) {
    this.env = env;
    this.store = store;
    this.io = io;
    this.notifier = notifier;
    this.stateStore = stateStore || null;

    // Per-(deviceId, kind) state: { breachStartedAt, lastNotifiedAt, active }
    this.state = new Map();
    this.history = [];

    const saved = stateStore?.getSnapshot?.() || { config: {}, assetLimits: {} };

    // Runtime tunables. Precedence: saved file > .env > code default.
    this.config = {
      thresholdDeg: pickNum(saved.config?.thresholdDeg, env.alerts.thresholdDeg),
      sustainMinutes: pickNum(saved.config?.sustainMinutes, env.alerts.sustainMinutes),
      cooldownMinutes: pickNum(saved.config?.cooldownMinutes, env.alerts.cooldownMinutes),
      enableUndercool: pickBool(saved.config?.enableUndercool, env.alerts.enableUndercool),
      thresholdLowDeg: pickNum(saved.config?.thresholdLowDeg, env.alerts.thresholdLowDeg)
    };

    // Per-asset absolute limits: { [assetId]: { high: number|null, low: number|null } }
    this.assetLimits = {};
    const defHigh = Number.isFinite(env.alerts.defaultHighLimit) ? env.alerts.defaultHighLimit : null;
    const defLow = Number.isFinite(env.alerts.defaultLowLimit) ? env.alerts.defaultLowLimit : null;
    for (const assetId of env.gateway.assets) {
      const savedLim = saved.assetLimits?.[assetId];
      this.assetLimits[assetId] = {
        high: savedLim && Object.prototype.hasOwnProperty.call(savedLim, "high") ? savedLim.high : defHigh,
        low: savedLim && Object.prototype.hasOwnProperty.call(savedLim, "low") ? savedLim.low : defLow
      };
    }
  }

  _persist() {
    if (!this.stateStore) return;
    this.stateStore.update({
      config: { ...this.config },
      assetLimits: { ...this.assetLimits }
    });
  }

  getConfig() {
    return { ...this.config };
  }

  updateConfig(patch = {}) {
    const next = { ...this.config };
    if (Number.isFinite(patch.thresholdDeg)) next.thresholdDeg = patch.thresholdDeg;
    if (Number.isFinite(patch.sustainMinutes)) next.sustainMinutes = patch.sustainMinutes;
    if (Number.isFinite(patch.cooldownMinutes)) next.cooldownMinutes = patch.cooldownMinutes;
    if (Number.isFinite(patch.thresholdLowDeg)) next.thresholdLowDeg = patch.thresholdLowDeg;
    if (typeof patch.enableUndercool === "boolean") next.enableUndercool = patch.enableUndercool;
    this.config = next;
    this._persist();
    return this.getConfig();
  }

  getAssetLimits() {
    // Always echo all known assets so the UI can render rows even if never set
    const out = {};
    for (const assetId of this.env.gateway.assets) {
      out[assetId] = this.assetLimits[assetId] || { high: null, low: null };
    }
    return out;
  }

  // patch shape: { [assetId]: { high?: number|null, low?: number|null } }
  updateAssetLimits(patch = {}) {
    Object.entries(patch).forEach(([assetId, limits]) => {
      if (!this.env.gateway.assets.includes(assetId)) return;
      const current = this.assetLimits[assetId] || { high: null, low: null };
      const next = { ...current };
      if (limits && Object.prototype.hasOwnProperty.call(limits, "high")) {
        next.high =
          limits.high === null || limits.high === "" || limits.high === undefined
            ? null
            : Number(limits.high);
        if (!Number.isFinite(next.high)) next.high = null;
      }
      if (limits && Object.prototype.hasOwnProperty.call(limits, "low")) {
        next.low =
          limits.low === null || limits.low === "" || limits.low === undefined
            ? null
            : Number(limits.low);
        if (!Number.isFinite(next.low)) next.low = null;
      }
      this.assetLimits[assetId] = next;
    });
    this._persist();
    return this.getAssetLimits();
  }

  getHistory(limit = 50) {
    return this.history.slice(0, limit);
  }

  // Clears recent history. By default also clears active state so dashboards
  // reflect the reset; pass { keepActive: true } to only wipe the log.
  clearHistory({ keepActive = false } = {}) {
    const cleared = this.history.length;
    this.history = [];
    if (!keepActive) {
      this.state.clear();
    }
    this.io?.emit("alerts_cleared", {
      timestamp: new Date().toISOString(),
      cleared,
      keepActive
    });
    return { cleared, keepActive };
  }

  getActiveAlerts() {
    const active = [];
    for (const [stateKey, st] of this.state.entries()) {
      if (st.active) {
        const [deviceId, kind] = stateKey.split("|");
        active.push({ deviceId, kind, ...st });
      }
    }
    return active;
  }

  evaluate(record) {
    if (!record || record.sourceType !== "live") return;

    const deviceId = record.deviceId;
    const mv = record.metrics?.mv;
    const sp = record.metrics?.sp;
    const buzzer = record.metrics?.buzzer;
    const now = new Date(record.timestamp || record.receivedAt);

    // Buzzer alarm — hardware signal, fires immediately (no sustain window).
    // Still respects cooldown so the same alarm doesn't spam.
    if (buzzer === 1) {
      this._evaluateBuzzer({ record, now, mv, sp });
    } else {
      this._clearKind(deviceId, "buzzer");
    }

    if (!isNum(mv)) return;

    // Deviation rules (overheat/undercool vs SP) — always evaluated regardless
    // of the gateway's "operational" flag. We still need a valid SP to compare
    // against; if SP is missing/invalid we cannot judge deviation, so clear.
    if (isNum(sp)) {
      const overheatDelta = mv - sp;
      const undercoolDelta = sp - mv;
      const overheatBreach = overheatDelta > this.config.thresholdDeg;
      const undercoolBreach =
        this.config.enableUndercool && undercoolDelta > this.config.thresholdLowDeg;

      if (overheatBreach) {
        this._evaluateBreach({
          record,
          kind: "overheat",
          now,
          delta: overheatDelta,
          mv,
          sp,
          threshold: this.config.thresholdDeg
        });
      } else {
        this._clearKind(deviceId, "overheat");
      }

      if (undercoolBreach) {
        this._evaluateBreach({
          record,
          kind: "undercool",
          now,
          delta: undercoolDelta,
          mv,
          sp,
          threshold: this.config.thresholdLowDeg
        });
      } else {
        this._clearKind(deviceId, "undercool");
      }
    } else {
      this._clearKind(deviceId, "overheat");
      this._clearKind(deviceId, "undercool");
    }

    // --- Absolute band rules ---
    const limits = this.assetLimits[deviceId] || {};
    if (isNum(limits.high) && mv > limits.high) {
      this._evaluateBreach({
        record,
        kind: "high_limit",
        now,
        delta: mv - limits.high,
        mv,
        sp,
        threshold: limits.high
      });
    } else {
      this._clearKind(deviceId, "high_limit");
    }

    if (isNum(limits.low) && mv < limits.low) {
      this._evaluateBreach({
        record,
        kind: "low_limit",
        now,
        delta: limits.low - mv,
        mv,
        sp,
        threshold: limits.low
      });
    } else {
      this._clearKind(deviceId, "low_limit");
    }
  }

  _stateKey(deviceId, kind) {
    return `${deviceId}|${kind}`;
  }

  _evaluateBreach({ record, kind, now, delta, mv, sp, threshold }) {
    const key = this._stateKey(record.deviceId, kind);
    const st = this.state.get(key) || {
      breachStartedAt: null,
      lastNotifiedAt: null,
      active: false
    };

    if (!st.breachStartedAt) {
      st.breachStartedAt = now.toISOString();
    }

    const sustainedMs = now.getTime() - new Date(st.breachStartedAt).getTime();
    const requiredMs = this.config.sustainMinutes * 60 * 1000;

    if (sustainedMs >= requiredMs) {
      const cooldownMs = this.config.cooldownMinutes * 60 * 1000;
      const lastTs = st.lastNotifiedAt ? new Date(st.lastNotifiedAt).getTime() : 0;
      const cooledDown = !lastTs || now.getTime() - lastTs >= cooldownMs;

      if (cooledDown) {
        st.lastNotifiedAt = now.toISOString();
        st.active = true;
        this.state.set(key, st);
        this._fire({ record, kind, mv, sp, delta, threshold, sustainedMs });
        return;
      }
      st.active = true;
    }
    this.state.set(key, st);
  }

  _evaluateBuzzer({ record, now, mv, sp }) {
    const key = this._stateKey(record.deviceId, "buzzer");
    const st = this.state.get(key) || { breachStartedAt: null, lastNotifiedAt: null, active: false };

    const cooldownMs = this.config.cooldownMinutes * 60 * 1000;
    const lastTs = st.lastNotifiedAt ? new Date(st.lastNotifiedAt).getTime() : 0;
    const cooledDown = !lastTs || now.getTime() - lastTs >= cooldownMs;

    if (cooledDown) {
      st.lastNotifiedAt = now.toISOString();
      st.breachStartedAt = now.toISOString();
      st.active = true;
      this.state.set(key, st);
      this._fire({ record, kind: "buzzer", mv, sp, delta: isNum(mv) && isNum(sp) ? mv - sp : null, threshold: null, sustainedMs: 0 });
    } else {
      st.active = true;
      this.state.set(key, st);
    }
  }

  _clearKind(deviceId, kind) {
    const key = this._stateKey(deviceId, kind);
    const st = this.state.get(key);
    if (!st) return;
    if (st.active) {
      const recovery = {
        id: `recovery-${deviceId}-${kind}-${Date.now()}`,
        kind: "recovery",
        previousKind: kind,
        deviceId,
        timestamp: new Date().toISOString(),
        message: `Furnace ${deviceId} returned within tolerance (${kind}).`
      };
      this.history.unshift(recovery);
      if (this.history.length > ALERT_HISTORY_MAX) this.history.length = ALERT_HISTORY_MAX;
      this.io?.emit("alert_recovered", recovery);
    }
    this.state.delete(key);
  }

  _clearAll(deviceId) {
    ["overheat", "undercool", "high_limit", "low_limit", "buzzer"].forEach((kind) =>
      this._clearKind(deviceId, kind)
    );
  }

  _fire({ record, kind, mv, sp, delta, threshold, sustainedMs }) {
    const sustainedMin = Math.round(sustainedMs / 60000);
    const tag = record.assetTag || record.deviceId;
    const name = record.assetName || "Furnace";

    const meta = ALERT_KIND_META[kind] || ALERT_KIND_META.overheat;
    const subject = `${meta.label} — ${tag} (${name})`;

    const alert = {
      id: `alert-${record.deviceId}-${kind}-${Date.now()}`,
      kind,
      severity: meta.severity,
      deviceId: record.deviceId,
      assetId: record.assetId,
      assetTag: record.assetTag,
      assetName: record.assetName,
      location: record.location,
      mv,
      sp,
      delta,
      threshold,
      unit: record.metrics?.unit || "degC",
      sustainedMinutes: sustainedMin,
      thresholdDeg: threshold, // back-compat alias
      timestamp: new Date().toISOString(),
      subject,
      message: meta.renderMessage({ mv, sp, delta, threshold, sustainedMin })
    };

    this.history.unshift(alert);
    if (this.history.length > ALERT_HISTORY_MAX) this.history.length = ALERT_HISTORY_MAX;

    this.io?.emit("alert_triggered", alert);

    if (this.notifier) {
      this.notifier.dispatch(alert).then((entry) => {
        // Annotate the in-memory alert with the dispatch outcome so the
        // history endpoint and the UI can show channel-by-channel status.
        const target = this.history.find((a) => a.id === alert.id);
        if (target) target.dispatch = entry?.results || null;
        this.io?.emit("notification_dispatched", {
          alertId: alert.id,
          deviceId: alert.deviceId,
          at: entry?.at || new Date().toISOString(),
          results: entry?.results || {}
        });
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[Alert] notifier failed: ${err.message}`);
      });
    }
  }
}

const ALERT_KIND_META = {
  buzzer: {
    label: "BUZZER ALARM",
    severity: "critical",
    renderMessage: ({ mv, sp }) =>
      `Hardware buzzer alarm triggered — temperature setpoint (${fmtDeg(sp)}) and measured value (${fmtDeg(mv)}) crossed.`
  },
  overheat: {
    label: "OVERHEAT ALERT",
    severity: "critical",
    renderMessage: ({ mv, sp, delta, sustainedMin }) =>
      `MV ${fmtDeg(mv)} exceeded SP ${fmtDeg(sp)} by ${fmtDeg(delta)} for ${sustainedMin} min.`
  },
  undercool: {
    label: "UNDERCOOL ALERT",
    severity: "warning",
    renderMessage: ({ mv, sp, delta, sustainedMin }) =>
      `MV ${fmtDeg(mv)} fell below SP ${fmtDeg(sp)} by ${fmtDeg(delta)} for ${sustainedMin} min.`
  },
  high_limit: {
    label: "HIGH TEMPERATURE LIMIT",
    severity: "critical",
    renderMessage: ({ mv, threshold, sustainedMin }) =>
      `MV ${fmtDeg(mv)} crossed the high limit of ${fmtDeg(threshold)} for ${sustainedMin} min.`
  },
  low_limit: {
    label: "LOW TEMPERATURE LIMIT",
    severity: "warning",
    renderMessage: ({ mv, threshold, sustainedMin }) =>
      `MV ${fmtDeg(mv)} dropped below the low limit of ${fmtDeg(threshold)} for ${sustainedMin} min.`
  }
};
