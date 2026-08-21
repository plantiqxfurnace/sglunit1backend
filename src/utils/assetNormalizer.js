// Flatten an asset block (from live HTTP or S3 batch JSON) into the
// store record shape consumed by routes and the alert engine.
//
// SGL Unit 1 live + S3 payload uses the STANDARD_MONITOR schema:
//   asset.metrics.Temperature.TEMPRATURE_SETPOINT.measuredValue  → sp
//   asset.metrics.Temperature.TEMPRATURE_PROCESSVALUE.measuredValue → mv
//   asset.metrics["Programmer Temperature"].PROGRAMMER_SETPOINT.measuredValue → sp2 (F2/F3)
//   asset.metrics["Programmer Temperature"].PROGRAMMER_PROCESSVALUE.measuredValue → mv2 (F2/F3)
//   asset.metrics.Status.BUZZER_ALARM.measuredValue → buzzer (0 or 1)
//   asset.metrics.Process.PROCESS_CYCLE.measuredValue → processCycle
//   asset.metrics.ID.PROGRAM_ID.measuredValue → programId

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

const measuredNum = (obj) => {
  if (!obj || typeof obj !== "object") return null;
  return num(obj.measuredValue);
};

const pickValue = (obj) => {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.value === "number") return obj.value;
  return null;
};

const pickUnit = (obj, fallback = "degC") => {
  if (!obj || typeof obj !== "object") return fallback;
  return obj.unit || fallback;
};

// Extract timestamp from an S3 key in the format:
//   .../SGL_UNIT_1_FUR_01/2026-07-07/16-24-21.gz
const extractTimestampFromKey = (key) => {
  if (!key) return null;
  const m = key.match(/(\d{4}-\d{2}-\d{2})\/(\d{2}-\d{2}-\d{2})(?:\.gz)?(?:\?.*)?$/);
  if (!m) return null;
  return `${m[1]}T${m[2].replace(/-/g, ":")}`;
};

// Shared logic for STANDARD_MONITOR metrics extraction (live + S3)
const extractStandardMetrics = (asset) => {
  const m = asset.metrics || {};
  const temp = m.Temperature || {};
  const prog = m["Programmer Temperature"] || {};
  const status = m.Status || {};
  const process_ = m.Process || {};
  const idBlock = m.ID || {};

  const sp = measuredNum(temp.TEMPRATURE_SETPOINT);
  const mv = measuredNum(temp.TEMPRATURE_PROCESSVALUE);
  const sp2 = measuredNum(prog.PROGRAMMER_SETPOINT);
  const mv2 = measuredNum(prog.PROGRAMMER_PROCESSVALUE);
  const buzzer = measuredNum(status.BUZZER_ALARM) ?? 0;
  const processCycle = measuredNum(process_.PROCESS_CYCLE);
  const cycleCount = measuredNum(process_.cycle_count);
  const programId = measuredNum(idBlock.PROGRAM_ID);
  // Computed deviation (MV - SP)
  const deviation = (mv !== null && sp !== null) ? +(mv - sp).toFixed(2) : null;

  return { mv, sp, mv2, sp2, buzzer, processCycle, cycleCount, programId, deviation };
};

// Live payload — STANDARD_MONITOR schema (asset.metrics nested by category)
export const normalizeLiveAsset = ({ asset, gateway }) => {
  const extracted = extractStandardMetrics(asset);
  const timestamp =
    asset.timestamp ||
    (gateway && (gateway.timestamp || gateway.reportDate)) ||
    new Date().toISOString();

  // assetStatus is a top-level field on the asset ("Idle", "Running", "OFF", etc.)
  const assetStatus = asset.assetStatus || null;

  return { timestamp, unit: "degC", assetStatus, ...extracted };
};

// S3 batch payload — STANDARD_MONITOR format (same schema as live)
// Falls back to old temperatureSummary format if asset.metrics is absent.
export const normalizeS3Asset = ({ asset, gateway, s3Key }) => {
  // STANDARD_MONITOR format — same as live payload
  if (asset.metrics) {
    const extracted = extractStandardMetrics(asset);
    const timestamp =
      asset.timestamp ||
      (gateway && (gateway.timestamp || gateway.reportDate || gateway.generatedAt)) ||
      extractTimestampFromKey(s3Key) ||
      new Date().toISOString();

    return {
      ...extracted,
      unit: "degC",
      timestamp,
      intervalStart: gateway?.intervalWindow?.start || null,
      intervalEnd:   gateway?.intervalWindow?.end   || null,
      durationMins:  gateway?.intervalWindow?.durationMins ?? null,
    };
  }

  // Legacy temperatureSummary format (old S3 files)
  const summary = asset.temperatureSummary || {};
  const cycle   = asset.cycle || {};
  return {
    intervalStart:  gateway?.intervalWindow?.start || null,
    intervalEnd:    gateway?.intervalWindow?.end   || null,
    durationMins:   gateway?.intervalWindow?.durationMins ?? null,
    timestamp:      gateway?.intervalWindow?.end || gateway?.reportDate ||
                    extractTimestampFromKey(s3Key) || null,
    sp:             num(pickValue(summary.sp)),
    mv_avg:         num(pickValue(summary.mv_avg)),
    mv_min:         num(pickValue(summary.mv_min)),
    mv_max:         num(pickValue(summary.mv_max)),
    deviation:      num(pickValue(summary.deviation)),
    unit:           pickUnit(summary.sp),
    sampleCount:    summary.sampleCount ?? null,
    cycleIndex:     cycle.cycleIndex     ?? null,
    cycleStartTime: cycle.cycleStartTime ?? null,
    cycleEndTime:   cycle.cycleEndTime   ?? null,
    operational:    Boolean(asset.operational),
    cycleStatus:    asset.cycleStatus || null,
    readings: Array.isArray(asset.readings)
      ? asset.readings.map((r) => ({
          timestamp:   r.timestamp,
          pv:          num(pickValue(r.pv)),
          sv:          num(pickValue(r.sv)),
          cycleStatus: r.cycleStatus
        }))
      : []
  };
};

// Build a normalized "record" envelope used by store/UI
export const normalizeAssetToRecord = ({ asset, gateway, sourceType, s3Key = null }) => {
  const isS3 = sourceType === "s3";
  const metrics = isS3
    ? normalizeS3Asset({ asset, gateway, s3Key })
    : normalizeLiveAsset({ asset, gateway });

  const deviceId = asset.assetId || asset.deviceId || "unknown-device";
  const timestamp = metrics.timestamp || new Date().toISOString();

  const parsedMetrics = {};
  Object.entries(metrics).forEach(([key, value]) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) return; // readings array kept separately
    parsedMetrics[key] = value;
  });

  return {
    id: `${sourceType}-${deviceId}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    sourceType,
    topic: null,
    s3Key,
    deviceId,
    assetId: deviceId,
    assetName: asset.assetName || null,
    assetTag:  asset.assetTag  || null,
    assetType: asset.assetType || null,
    location:  asset.location  || null,
    timestamp,
    receivedAt: new Date().toISOString(),
    parsedMetrics,
    metrics,
    readings: metrics.readings || [],
    parseError: null
  };
};
