import express from "express";

export const createApiRouter = ({ store, s3Service, alertEngine, notifier, env }) => {
  const router = express.Router();

  const compactRecord = (record) => ({
    id: record.id,
    sourceType: record.sourceType,
    s3Key: record.s3Key,
    deviceId: record.deviceId,
    assetId: record.assetId,
    assetName: record.assetName,
    assetTag: record.assetTag,
    location: record.location,
    timestamp: record.timestamp,
    receivedAt: record.receivedAt,
    parsedMetrics: record.parsedMetrics,
    metrics: record.metrics,
    readings: record.readings,
    parseError: record.parseError
  });

  router.get("/health", async (_req, res) => {
    if (s3Service?.isConfigured()) {
      await s3Service.checkAvailability();
    }
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      connection: store.getConnectionStatus(),
      gateway: store.getGatewayInfo(),
      debug: store.getDebugSummary()
    });
  });

  router.get("/gateway", (_req, res) => {
    res.json({
      gateway: store.getGatewayInfo(),
      config: {
        id: env.gateway.id,
        org: env.gateway.org,
        plant: env.gateway.plant,
        assets: env.gateway.assets
      }
    });
  });

  router.get("/messages/live", (req, res) => {
    const limit = Number(req.query.limit || 100);
    const items = store.getLiveMessages(limit);
    res.json({ items, count: items.length });
  });

  router.get("/messages/latest", (_req, res) => {
    const items = store.getLatestByDevice();
    res.json({ items, count: items.length });
  });

  router.get("/devices", (_req, res) => {
    const items = store.getDevices();
    res.json({ items, count: items.length });
  });

  router.get("/device/:deviceId/records", (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const limit = Number(req.query.limit || 100);
    const details = store.getDeviceDetails(deviceId, limit);
    res.json({
      deviceId: details.deviceId,
      meta: details.meta,
      latest: details.latest ? compactRecord(details.latest) : null,
      records: details.records.map(compactRecord)
    });
  });

  router.get("/combined/latest", (_req, res) => {
    const items = store.getLatestByDevice();
    res.json({
      items,
      count: items.length,
      note: "Latest known record by detected asset across live HTTP and S3."
    });
  });

  // === S3 (gateway path-aware) ===
  router.get("/s3/files", async (_req, res) => {
    if (!s3Service?.isConfigured()) {
      return res.status(400).json({ error: "S3 is not configured." });
    }
    const result = await s3Service.listFiles({ limit: 60 });
    if (result.error) return res.status(500).json(result);
    return res.json(result);
  });

  router.get("/s3/file/:key", async (req, res) => {
    if (!s3Service?.isConfigured()) {
      return res.status(400).json({ error: "S3 is not configured." });
    }
    const key = decodeURIComponent(req.params.key);
    const result = await s3Service.readFile(key);
    if (result.error) return res.status(500).json(result);
    return res.json(result);
  });

  router.get("/s3/discover/latest", async (_req, res) => {
    if (!s3Service?.isConfigured()) {
      return res.status(400).json({ error: "S3 is not configured." });
    }
    const result = await s3Service.loadLatestPerAsset();
    if (result.error) return res.status(500).json(result);
    return res.json(result);
  });

  router.get("/s3/devices", async (_req, res) => {
    if (!s3Service?.isConfigured()) {
      return res.status(400).json({ error: "S3 is not configured." });
    }
    const result = await s3Service.listDevices();
    if (result.error) return res.status(500).json(result);
    return res.json(result);
  });

  router.get("/s3/device/:deviceId/files", async (req, res) => {
    if (!s3Service?.isConfigured()) {
      return res.status(400).json({ error: "S3 is not configured." });
    }
    const deviceId = decodeURIComponent(req.params.deviceId);
    const dateStr = req.query.date || null;
    const result = await s3Service.listDeviceFiles(deviceId, { dateStr, limit: 200 });
    if (result.error) return res.status(500).json(result);
    return res.json(result);
  });

  // Load recent S3 files for a device into the in-memory store so they appear in record history.
  router.get("/s3/device/:deviceId/load-recent", async (req, res) => {
    if (!s3Service?.isConfigured()) {
      return res.status(400).json({ error: "S3 is not configured." });
    }
    const deviceId = decodeURIComponent(req.params.deviceId);
    const limit = Number(req.query.limit || 100);
    const result = await s3Service.loadRecentForDevice(deviceId, limit);
    if (result.error) return res.status(500).json(result);
    return res.json(result);
  });

  // ── Cycles ────────────────────────────────────────────────────────────────
  // GET /api/cycles/daily?month=YYYY-MM
  // Returns cycle transition counts per day per furnace for the given month.
  router.get("/cycles/daily", (req, res) => {
    const monthStr = (req.query.month || new Date().toISOString().slice(0, 7)).trim();
    const deviceIds = env.gateway?.assets || [];

    const days = {}; // { "YYYY-MM-DD": { deviceId: count } }

    // Infer controller→pair mapping from sorted asset IDs (F01→F02, F03→F04)
    const sorted = [...deviceIds].sort();
    const controllerMap = {};
    for (let i = 0; i + 1 < sorted.length; i += 2) {
      controllerMap[sorted[i]] = sorted[i + 1];
    }

    deviceIds.forEach((deviceId) => {
      const records = store.getDeviceRecords(deviceId, 3000);

      // Filter to selected month, oldest→newest
      const monthRecords = records
        .filter((r) => r.timestamp && r.timestamp.startsWith(monthStr))
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      let prevCycle = null;

      monthRecords.forEach((r) => {
        const pc =
          r.metrics?.processCycle !== undefined
            ? r.metrics.processCycle
            : r.parsedMetrics?.processCycle;
        if (pc === null || pc === undefined) return;

        const date = r.timestamp.slice(0, 10);

        if (prevCycle !== null && prevCycle !== pc) {
          // Transition detected — count for this device
          if (!days[date]) days[date] = {};
          days[date][deviceId] = (days[date][deviceId] || 0) + 1;

          // Mirror to paired furnace (they share the same cycle)
          const paired = controllerMap[deviceId];
          if (paired) {
            days[date][paired] = (days[date][paired] || 0) + 1;
          }
        }
        prevCycle = pc;
      });
    });

    // Current live PROCESS_CYCLE for each furnace (stat boxes)
    const current = {};
    deviceIds.forEach((deviceId) => {
      const latest = store.latestByDevice.get(deviceId);
      if (latest) {
        current[deviceId] = {
          assetTag: latest.assetTag || null,
          processCycle: latest.metrics?.processCycle ?? latest.parsedMetrics?.processCycle ?? null,
          cycleActive: latest.metrics?.cycleActive ?? latest.parsedMetrics?.cycleActive ?? null,
          assetStatus: latest.metrics?.assetStatus ?? null,
        };
      }
    });

    res.json({ month: monthStr, days, current });
  });

  router.get("/s3/device/:deviceId/dates", async (req, res) => {
    if (!s3Service?.isConfigured()) {
      return res.status(400).json({ error: "S3 is not configured." });
    }
    const deviceId = decodeURIComponent(req.params.deviceId);
    const result = await s3Service.listAssetDates(deviceId);
    if (result.error) return res.status(500).json(result);
    return res.json(result);
  });

  // === Alerts ===
  router.get("/alerts", (req, res) => {
    const limit = Number(req.query.limit || 50);
    res.json({
      active: alertEngine.getActiveAlerts(),
      history: alertEngine.getHistory(limit),
      config: alertEngine.getConfig(),
      assetLimits: alertEngine.getAssetLimits()
    });
  });

  router.get("/alerts/config", (_req, res) => {
    res.json({
      config: alertEngine.getConfig(),
      assetLimits: alertEngine.getAssetLimits()
    });
  });

  router.put("/alerts/config", (req, res) => {
    const next = alertEngine.updateConfig(req.body || {});
    res.json({ config: next });
  });

  router.post("/alerts/clear", (req, res) => {
    const keepActive = Boolean(req.body?.keepActive);
    const result = alertEngine.clearHistory({ keepActive });
    res.json({ ok: true, ...result });
  });

  router.get("/alerts/asset-limits", (_req, res) => {
    res.json({ assetLimits: alertEngine.getAssetLimits() });
  });

  router.put("/alerts/asset-limits", (req, res) => {
    const next = alertEngine.updateAssetLimits(req.body || {});
    res.json({ assetLimits: next });
  });

  router.get("/alerts/subscribers", (_req, res) => {
    res.json({ subscribers: notifier.getSubscribers(), status: notifier.getStatus() });
  });

  router.post("/alerts/subscribers/email", (req, res) => {
    const ok = notifier.addEmail(req.body?.email);
    if (!ok) return res.status(400).json({ error: "Invalid email" });
    res.json({ subscribers: notifier.getSubscribers() });
  });

  router.delete("/alerts/subscribers/email", (req, res) => {
    notifier.removeEmail(req.body?.email || req.query?.email);
    res.json({ subscribers: notifier.getSubscribers() });
  });

  router.post("/alerts/subscribers/whatsapp", (req, res) => {
    const ok = notifier.addWhatsapp(req.body?.number);
    if (!ok) return res.status(400).json({ error: "Invalid number" });
    res.json({ subscribers: notifier.getSubscribers() });
  });

  router.delete("/alerts/subscribers/whatsapp", (req, res) => {
    notifier.removeWhatsapp(req.body?.number || req.query?.number);
    res.json({ subscribers: notifier.getSubscribers() });
  });

  router.post("/alerts/test", async (req, res) => {
    try {
      const channel = req.body?.channel || "all";
      const result = await notifier.sendTest({ channel, overrides: req.body?.overrides });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};
