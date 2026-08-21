import { normalizeAssetToRecord } from "../utils/assetNormalizer.js";

// Polls the gateway live HTTP endpoint and fans out per-asset records
// into the store + socket.io. Replaces the previous MQTT path.
export class LiveService {
  constructor({ env, store, io, alertEngine }) {
    this.env = env;
    this.store = store;
    this.io = io;
    this.alertEngine = alertEngine;
    this.timer = null;
    this.inFlight = false;
    this.lastGatewayTimestamp = null;
  }

  start() {
    if (!this.env.live.url) {
      this.store.setLiveStatus("disabled", "LIVE_API_URL not configured");
      return;
    }
    this.store.setLiveStatus("connecting", null);
    this.tick();
    this.timer = setInterval(() => this.tick(), this.env.live.pollIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const payload = await this._fetchLive();
      this._handlePayload(payload);
    } catch (error) {
      const message = `Live poll failed: ${error.message}`;
      this.store.setLiveStatus("error", message);
      this.store.setLastError(message);
      this.io.emit("live_status", this.store.getConnectionStatus().live);
    } finally {
      this.inFlight = false;
    }
  }

  async _fetchLive() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.env.live.requestTimeoutMs);
    try {
      const response = await fetch(this.env.live.url, {
        signal: controller.signal,
        headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  _handlePayload(payload) {
    if (this.env.debug.logLivePayloads) {
      // eslint-disable-next-line no-console
      console.log(`[LIVE] ${JSON.stringify(payload).slice(0, 400)}…`);
    }

    if (!payload || typeof payload !== "object") {
      this.store.setLiveStatus("error", "Live payload is not an object");
      return;
    }

    const items = Array.isArray(payload) ? payload : [payload];
    const flatAssets = [];
    items.forEach((item) => {
      if (Array.isArray(item.assets)) {
        item.assets.forEach((asset) => flatAssets.push({ asset, gateway: item }));
      } else if (item.assetId) {
        flatAssets.push({ asset: item, gateway: {} });
      }
    });

    if (flatAssets.length === 0) {
      this.store.setLiveStatus("error", "No assets in live payload");
      return;
    }

    // STANDARD_MONITOR schema: gateway info is under item.gateway sub-object
    const topItem = items[0] || {};
    const gatewayMeta = topItem.gateway || topItem;
    this.store.setGatewayInfo({
      gatewayId: gatewayMeta.gatewayId || this.env.gateway.id,
      gatewayName: gatewayMeta.gatewayName || null,
      gatewayType: gatewayMeta.gatewayType || null,
      protocol: gatewayMeta.protocol || null,
      reportDate: topItem.reportDate || null,
      timestamp: gatewayMeta.timestamp || null,
      messageId: topItem.messageId || null,
      metadata: topItem.metadata || null
    });

    this.store.setLiveStatus("connected", null);
    this.lastGatewayTimestamp = gatewayMeta.timestamp || null;

    const records = flatAssets.map(({ asset, gateway }) =>
      normalizeAssetToRecord({ asset, gateway, sourceType: "live" })
    );

    // Cross-asset cycle status logic:
    //   F1's PROCESS_CYCLE controls the F1/F2 pair: 0 → F1 active, 1 → F2 active
    //   F3's PROCESS_CYCLE controls the F3/F4 pair: 0 → F3 active, 1 → F4 active
    const cycleByTag = {};
    records.forEach((r) => {
      const tag = r.assetTag;
      if (tag === "F1" || tag === "F3") {
        cycleByTag[tag] = r.metrics.processCycle;
      }
    });
    records.forEach((r) => {
      const tag = r.assetTag;
      let cycleActive = null;
      if (tag === "F1") cycleActive = cycleByTag["F1"] === 0;
      else if (tag === "F2") cycleActive = cycleByTag["F1"] === 1;
      else if (tag === "F3") cycleActive = cycleByTag["F3"] === 0;
      else if (tag === "F4") cycleActive = cycleByTag["F3"] === 1;
      if (cycleActive !== null) {
        r.metrics.cycleActive = cycleActive;
        r.parsedMetrics.cycleActive = cycleActive;
      }
    });

    records.forEach((record) => {
      this.store.addRecord(record, { isLive: true });
      this.io.emit("live_message", record);

      if (this.alertEngine) {
        this.alertEngine.evaluate(record);
      }
    });

    this.io.emit("latest_snapshot", {
      latestByDevice: this.store.getLatestByDevice(),
      devices: this.store.getDevices(),
      gateway: this.store.getGatewayInfo(),
      debug: this.store.getDebugSummary()
    });
    this.io.emit("live_status", this.store.getConnectionStatus().live);
  }
}
