import { detectIdentifier, detectTimestamp, extractMetrics } from "./identifier.js";

export const safeJsonParse = (raw) => {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
};

const parseLineDelimitedJson = (raw) => {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return { ok: false, error: "No content" };

  const results = [];
  for (const line of lines) {
    const parsed = safeJsonParse(line);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    results.push(parsed.value);
  }

  return { ok: true, value: results };
};

const parseCsvLike = (raw) => {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2 || !lines[0].includes(",")) {
    return { ok: false, error: "Not CSV-like content" };
  }

  const headers = lines[0].split(",").map((item) => item.trim());
  const rows = lines.slice(1).map((line) => line.split(",").map((item) => item.trim()));

  const objects = rows.map((cols) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = cols[index] ?? null;
    });
    return record;
  });

  return { ok: true, value: objects };
};

export const parseUnknownContent = (raw) => {
  const json = safeJsonParse(raw);
  if (json.ok) return { ok: true, value: json.value, mode: "json" };

  const ndjson = parseLineDelimitedJson(raw);
  if (ndjson.ok) return { ok: true, value: ndjson.value, mode: "ndjson" };

  const csv = parseCsvLike(raw);
  if (csv.ok) return { ok: true, value: csv.value, mode: "csv" };

  return { ok: false, error: "Could not parse content as JSON/NDJSON/CSV" };
};

const normalizeSingleRecord = ({
  sourceType,
  topic,
  s3Key,
  rawPayload,
  parsedPayload,
  parseError
}) => {
  const timestamp = detectTimestamp(parsedPayload);
  const deviceId = detectIdentifier({ parsedPayload, topic, s3Key });

  return {
    id: `${sourceType}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    sourceType,
    topic: topic || null,
    s3Key: s3Key || null,
    deviceId,
    timestamp,
    receivedAt: new Date().toISOString(),
    parsedMetrics: extractMetrics(parsedPayload),
    parsedPayload,
    rawPayload,
    parseError: parseError || null
  };
};

export const normalizeRecords = ({ sourceType, topic, s3Key, rawPayload, parsedData, parseError }) => {
  if (Array.isArray(parsedData)) {
    return parsedData.map((item) =>
      normalizeSingleRecord({
        sourceType,
        topic,
        s3Key,
        rawPayload,
        parsedPayload: item,
        parseError
      })
    );
  }

  return [
    normalizeSingleRecord({
      sourceType,
      topic,
      s3Key,
      rawPayload,
      parsedPayload: parsedData,
      parseError
    })
  ];
};
