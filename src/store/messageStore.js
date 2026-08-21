export class MessageStore {
  constructor(maxLiveMessages = 200) {
    this.maxLiveMessages = maxLiveMessages;
    this.perDeviceHistoryLimit = 3000;
    this.liveMessages = [];
    this.latestByDevice = new Map();
    this.deviceMeta = new Map();
    this.recordsByDevice = new Map();
    this.gatewayInfo = null;

    this.debug = {
      totalMessages: 0,
      liveMessages: 0,
      s3Records: 0,
      lastSourceType: null,
      lastError: null
    };

    this.connection = {
      live: {
        status: "disconnected",
        url: null,
        lastConnectedAt: null,
        lastError: null
      },
      s3: {
        status: "unknown",
        lastCheckedAt: null,
        lastError: null
      }
    };
  }

  setLiveStatus(status, error = null, url = null) {
    this.connection.live.status = status;
    this.connection.live.lastError = error || null;
    if (url) this.connection.live.url = url;
    if (status === "connected") this.connection.live.lastConnectedAt = new Date().toISOString();
  }

  setS3Status(status, error = null) {
    this.connection.s3.status = status;
    this.connection.s3.lastCheckedAt = new Date().toISOString();
    this.connection.s3.lastError = error || null;
  }

  setLastError(errorMessage) {
    this.debug.lastError = errorMessage;
  }

  setGatewayInfo(info) {
    this.gatewayInfo = { ...info, updatedAt: new Date().toISOString() };
  }

  getGatewayInfo() {
    return this.gatewayInfo;
  }

  addRecord(record, { isLive = false } = {}) {
    this.debug.totalMessages += 1;
    this.debug.lastSourceType = record.sourceType;

    if (record.sourceType === "live") this.debug.liveMessages += 1;
    if (record.sourceType === "s3") this.debug.s3Records += 1;

    if (isLive) {
      this.liveMessages.unshift(record);
      if (this.liveMessages.length > this.maxLiveMessages) {
        this.liveMessages.length = this.maxLiveMessages;
      }
    }

    const deviceId = record.deviceId || "unknown-device";
    this.latestByDevice.set(deviceId, record);

    const existingRecords = this.recordsByDevice.get(deviceId) || [];
    existingRecords.unshift(record);
    if (existingRecords.length > this.perDeviceHistoryLimit) {
      existingRecords.length = this.perDeviceHistoryLimit;
    }
    this.recordsByDevice.set(deviceId, existingRecords);

    const current = this.deviceMeta.get(deviceId) || {
      deviceId,
      assetName: record.assetName || null,
      assetTag: record.assetTag || null,
      assetType: record.assetType || null,
      messageCount: 0,
      lastSeenAt: null,
      lastSourceType: null
    };

    current.messageCount += 1;
    current.lastSeenAt = record.receivedAt;
    current.lastSourceType = record.sourceType;
    if (record.assetName) current.assetName = record.assetName;
    if (record.assetTag) current.assetTag = record.assetTag;
    if (record.assetType) current.assetType = record.assetType;

    this.deviceMeta.set(deviceId, current);
  }

  getLiveMessages(limit = 100) {
    return this.liveMessages.slice(0, limit);
  }

  getLatestByDevice() {
    return Array.from(this.latestByDevice.values()).sort((a, b) =>
      (a.assetTag || a.deviceId).localeCompare(b.assetTag || b.deviceId)
    );
  }

  getDevices() {
    return Array.from(this.deviceMeta.values()).sort((a, b) =>
      (a.assetTag || a.deviceId).localeCompare(b.assetTag || b.deviceId)
    );
  }

  getDeviceRecords(deviceId, limit = 100) {
    const records = this.recordsByDevice.get(deviceId) || [];
    return records.slice(0, limit);
  }

  getDeviceDetails(deviceId, limit = 100) {
    const meta = this.deviceMeta.get(deviceId) || {
      deviceId,
      messageCount: 0,
      lastSeenAt: null,
      lastSourceType: null
    };
    const latest = this.latestByDevice.get(deviceId) || null;
    const records = this.getDeviceRecords(deviceId, limit);

    return {
      deviceId,
      meta,
      latest,
      records
    };
  }

  getDebugSummary() {
    return {
      ...this.debug,
      liveBufferSize: this.liveMessages.length
    };
  }

  getConnectionStatus() {
    return this.connection;
  }

  getSnapshot() {
    return {
      connection: this.getConnectionStatus(),
      gateway: this.getGatewayInfo(),
      liveMessages: this.getLiveMessages(50),
      latestByDevice: this.getLatestByDevice(),
      devices: this.getDevices(),
      debug: this.getDebugSummary()
    };
  }
}
