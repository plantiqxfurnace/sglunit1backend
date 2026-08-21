const IDENTIFIER_KEYS = [
  "device_id",
  "deviceid",
  "device_uid",
  "deviceuid",
  "device",
  "furnace_id",
  "furnaceid",
  "furnace",
  "machine_id",
  "machineid",
  "asset_id",
  "assetid",
  "thing_name",
  "thingname",
  "client_id",
  "clientid",
  "id"
];

const TIMESTAMP_KEYS = [
  "timestamp",
  "ts",
  "time",
  "event_time",
  "eventtime",
  "created_at",
  "createdat",
  "reported_at",
  "reportedat",
  "datetime",
  "date"
];

const isPrimitive = (value) => ["string", "number", "boolean"].includes(typeof value);

const extractTopicIdentifier = (topic) => {
  if (!topic) return null;
  const parts = topic.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return parts[1];
};

const extractS3Identifier = (s3Key) => {
  if (!s3Key) return null;
  // Find ALL furnace-like segments (handles leading slash or start-of-string)
  // Return the LAST match — most specific (e.g. furnace_01 not Furnace-Gateway-01)
  const matches = [...s3Key.matchAll(/(?:^|\/)([Ff]urnace[-_][A-Za-z0-9]*\d+[A-Za-z0-9\-_]*)/g)];
  if (matches.length > 0) return matches[matches.length - 1][1];
  return null;
};

const normalizeTs = (value) => {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return normalizeTs(numeric);
    const isIsoWithoutTimezone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value);
    if (isIsoWithoutTimezone) return value;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  return null;
};

const searchByKeys = (input, wantedKeys, depth = 0) => {
  if (!input || typeof input !== "object" || depth > 4) return null;

  for (const [key, value] of Object.entries(input)) {
    if (wantedKeys.includes(key.toLowerCase()) && isPrimitive(value)) {
      return String(value);
    }
  }

  for (const value of Object.values(input)) {
    if (value && typeof value === "object") {
      const found = searchByKeys(value, wantedKeys, depth + 1);
      if (found) return found;
    }
  }

  return null;
};

const searchTimestamp = (input, depth = 0) => {
  if (!input || typeof input !== "object" || depth > 4) return null;

  for (const [key, value] of Object.entries(input)) {
    if (TIMESTAMP_KEYS.includes(key.toLowerCase())) {
      const normalized = normalizeTs(value);
      if (normalized) return normalized;
    }
  }

  for (const value of Object.values(input)) {
    if (value && typeof value === "object") {
      const found = searchTimestamp(value, depth + 1);
      if (found) return found;
    }
  }

  return null;
};

export const detectIdentifier = ({ parsedPayload, topic, s3Key }) => {
  if (parsedPayload && typeof parsedPayload === "object") {
    const found = searchByKeys(parsedPayload, IDENTIFIER_KEYS);
    if (found) return found;
  }

  return extractTopicIdentifier(topic) || extractS3Identifier(s3Key) || "unknown-device";
};

export const detectTimestamp = (parsedPayload) => {
  if (!parsedPayload || typeof parsedPayload !== "object") return new Date().toISOString();
  return searchTimestamp(parsedPayload) || new Date().toISOString();
};

export const extractMetrics = (parsedPayload) => {
  if (!parsedPayload || typeof parsedPayload !== "object") return {};

  if (Array.isArray(parsedPayload)) {
    return { record_count: parsedPayload.length };
  }

  const payloadKeys = Object.keys(parsedPayload);
  if (payloadKeys.length === 1 && payloadKeys[0] === "raw") {
    return {};
  }

  const metrics = {};
  const flatten = (value, prefix = "", depth = 0) => {
    if (value === null || value === undefined || depth > 6) return;

    if (["string", "number", "boolean"].includes(typeof value)) {
      if (prefix === "raw" && typeof value === "string") return;
      metrics[prefix || "value"] = value;
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const nextPrefix = prefix ? `${prefix}[${index}]` : `[${index}]`;
        flatten(item, nextPrefix, depth + 1);
      });
      return;
    }

    if (typeof value === "object") {
      Object.entries(value).forEach(([key, nested]) => {
        const nextPrefix = prefix ? `${prefix}.${key}` : key;
        flatten(nested, nextPrefix, depth + 1);
      });
    }
  };

  flatten(parsedPayload);

  return metrics;
};
