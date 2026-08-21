import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { gunzipSync } from "zlib";
import { hasS3Config } from "../config/env.js";
import { normalizeAssetToRecord } from "../utils/assetNormalizer.js";
import { safeJsonParse } from "../utils/parser.js";

const streamToBuffer = async (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });

const hasExplicitCreds = (creds) => Boolean(creds.accessKeyId && creds.secretAccessKey);

// Extract assetId from path: SGL_UNIT_1/JEEDIMETLA/<gatewayId>/<assetId>/<date>/...
const ASSET_FROM_KEY_REGEX = /\/([A-Z0-9][A-Z0-9_]{3,})\/\d{4}-\d{2}-\d{2}\//;
const extractAssetId = (key) => {
  if (!key) return null;
  const match = key.match(ASSET_FROM_KEY_REGEX);
  return match ? match[1] : null;
};

export class S3Service {
  constructor({ env, store }) {
    this.env = env;
    this.store = store;
    this.client = null;

    if (!hasS3Config) {
      this.store.setS3Status("disabled", "Missing AWS_S3_BUCKET");
      return;
    }

    this.client = new S3Client({
      region: this.env.s3.region,
      ...(hasExplicitCreds(this.env.awsCredentials)
        ? {
            credentials: {
              accessKeyId: this.env.awsCredentials.accessKeyId,
              secretAccessKey: this.env.awsCredentials.secretAccessKey,
              sessionToken: this.env.awsCredentials.sessionToken || undefined
            }
          }
        : {})
    });
  }

  isConfigured() {
    return Boolean(this.client);
  }

  // Compose prefixes for the gateway-aware path layout
  _assetPrefix(assetId) {
    return `${this.env.s3.prefix}${assetId}/`;
  }

  _assetDatePrefix(assetId, dateStr) {
    return `${this.env.s3.prefix}${assetId}/${dateStr}/`;
  }

  async checkAvailability() {
    if (!this.client) {
      this.store.setS3Status("disabled", "S3 client is not configured");
      return { ok: false, error: "S3 client is not configured" };
    }
    try {
      await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.env.s3.bucket,
          Prefix: this.env.s3.prefix || undefined,
          MaxKeys: 1
        })
      );
      this.store.setS3Status("available");
      return { ok: true };
    } catch (error) {
      const message = `S3 check failed: ${error.message}`;
      this.store.setS3Status("error", message);
      this.store.setLastError(message);
      return { ok: false, error: message };
    }
  }

  // List date folders inside an asset prefix
  async listAssetDates(assetId) {
    if (!this.client) return { dates: [], error: "S3 client is not configured" };
    try {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.env.s3.bucket,
          Prefix: this._assetPrefix(assetId),
          Delimiter: "/"
        })
      );
      const dates = (response.CommonPrefixes || [])
        .map((p) => p.Prefix)
        .map((p) => p.replace(this._assetPrefix(assetId), "").replace(/\/$/, ""))
        .filter(Boolean)
        .sort((a, b) => b.localeCompare(a));
      return { dates };
    } catch (error) {
      return { dates: [], error: error.message };
    }
  }

  // List all data files for an asset on a given date (or recent dates if omitted)
  async listAssetFiles(assetId, { dateStr = null, limit = 200 } = {}) {
    if (!this.client) return { files: [], error: "S3 client is not configured" };
    try {
      const prefix = dateStr ? this._assetDatePrefix(assetId, dateStr) : this._assetPrefix(assetId);
      const files = [];
      let continuationToken;
      do {
        const response = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.env.s3.bucket,
            Prefix: prefix,
            MaxKeys: 1000,
            ContinuationToken: continuationToken
          })
        );
        (response.Contents || [])
          .filter((item) => item.Key && !item.Key.endsWith("/"))
          .forEach((item) => {
            files.push({
              key: item.Key,
              size: item.Size,
              lastModified: item.LastModified ? new Date(item.LastModified).toISOString() : null
            });
          });
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
        if (files.length >= limit) break;
      } while (continuationToken);

      files.sort((a, b) => {
        const at = a.lastModified ? new Date(a.lastModified).getTime() : 0;
        const bt = b.lastModified ? new Date(b.lastModified).getTime() : 0;
        return bt - at;
      });

      return { files: files.slice(0, limit) };
    } catch (error) {
      return { files: [], error: error.message };
    }
  }

  // High-level: list files across known assets (for the dashboard)
  async listFiles({ limit = 50 } = {}) {
    if (!this.client) return { files: [], error: "S3 client is not configured" };
    try {
      const allFiles = [];
      for (const assetId of this.env.gateway.assets) {
        const r = await this.listAssetFiles(assetId, { limit: 20 });
        if (r.files) {
          r.files.forEach((f) => allFiles.push({ ...f, assetId }));
        }
      }
      allFiles.sort((a, b) => {
        const at = a.lastModified ? new Date(a.lastModified).getTime() : 0;
        const bt = b.lastModified ? new Date(b.lastModified).getTime() : 0;
        return bt - at;
      });
      this.store.setS3Status("available");
      return { files: allFiles.slice(0, limit) };
    } catch (error) {
      const message = `S3 list failed: ${error.message}`;
      this.store.setS3Status("error", message);
      return { files: [], error: message };
    }
  }

  async readFile(key) {
    if (!this.client) return { error: "S3 client is not configured" };
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.env.s3.bucket, Key: key })
      );
      const rawBuffer = await streamToBuffer(response.Body);
      const shouldGunzip =
        key.toLowerCase().endsWith(".gz") || String(response.ContentEncoding || "").includes("gzip");

      let decodedBuffer = rawBuffer;
      if (shouldGunzip) {
        try {
          decodedBuffer = gunzipSync(rawBuffer);
        } catch {
          decodedBuffer = rawBuffer;
        }
      }

      const rawPayload = decodedBuffer.toString("utf-8");
      const parsed = safeJsonParse(rawPayload);
      const parsedContent = parsed.ok ? parsed.value : null;
      const records = [];

      if (parsed.ok && parsedContent && Array.isArray(parsedContent.assets)) {
        parsedContent.assets.forEach((asset) => {
          const record = normalizeAssetToRecord({
            asset,
            // STANDARD_MONITOR: gateway info is under parsedContent.gateway sub-object
            gateway: parsedContent.gateway || parsedContent,
            sourceType: "s3",
            s3Key: key
          });
          this.store.addRecord(record);
          records.push(record);
        });
      } else if (parsed.ok) {
        // Best effort: treat as a single asset
        const record = normalizeAssetToRecord({
          asset: parsedContent || { assetId: extractAssetId(key) || "unknown" },
          gateway: {},
          sourceType: "s3",
          s3Key: key
        });
        this.store.addRecord(record);
        records.push(record);
      }

      this.store.setS3Status("available");

      return {
        key,
        rawPayload,
        parseMode: parsed.ok ? "json" : "raw",
        parseError: parsed.ok ? null : parsed.error,
        parsedContent,
        normalizedRecords: records
      };
    } catch (error) {
      const message = `S3 read failed for ${key}: ${error.message}`;
      this.store.setS3Status("error", message);
      this.store.setLastError(message);
      return { error: message };
    }
  }

  // Walk gateway assets and pull the most recent file per asset
  async loadLatestPerAsset() {
    if (!this.client) return { loaded: 0, error: "S3 client is not configured" };
    const results = [];
    const failed = [];
    for (const assetId of this.env.gateway.assets) {
      try {
        const { dates, error: dErr } = await this.listAssetDates(assetId);
        if (dErr || !dates || dates.length === 0) {
          failed.push({ assetId, error: dErr || "No dates found" });
          continue;
        }
        const latestDate = dates[0];
        const { files, error: fErr } = await this.listAssetFiles(assetId, {
          dateStr: latestDate,
          limit: 1
        });
        if (fErr || !files || files.length === 0) {
          failed.push({ assetId, error: fErr || "No files found" });
          continue;
        }
        const result = await this.readFile(files[0].key);
        if (result.error) {
          failed.push({ assetId, error: result.error });
        } else {
          results.push({ assetId, key: files[0].key });
        }
      } catch (err) {
        failed.push({ assetId, error: err.message });
      }
    }
    this.store.setS3Status("available");
    return { loaded: results.length, results, failed };
  }

  // Load the N most recent S3 files for a specific asset into the store.
  // Called from FurnacePage to populate the record history log.
  async loadRecentForDevice(assetId, limit = 100) {
    if (!this.client) return { loaded: 0, error: "S3 client is not configured" };
    try {
      const { files, error } = await this.listDeviceFiles(assetId, { limit });
      if (error) return { loaded: 0, error };
      if (!files || files.length === 0) return { loaded: 0, total: 0, failed: [] };

      let loaded = 0;
      const failed = [];
      const BATCH = 5;

      for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH);
        await Promise.all(
          batch.map(async (file) => {
            const result = await this.readFile(file.key);
            if (result.error) failed.push({ key: file.key, error: result.error });
            else loaded++;
          })
        );
      }

      this.store.setS3Status("available");
      return { loaded, total: files.length, failed };
    } catch (error) {
      const message = `S3 loadRecentForDevice failed: ${error.message}`;
      this.store.setS3Status("error", message);
      return { loaded: 0, error: message };
    }
  }

  async listDevices() {
    const devices = this.env.gateway.assets.map((assetId) => ({
      deviceId: assetId,
      assetId
    }));
    return { devices };
  }

  async listDeviceFiles(assetId, { dateStr = null, limit = 100 } = {}) {
    return this.listAssetFiles(assetId, { dateStr, limit });
  }
}
