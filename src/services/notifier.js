// Dispatches alerts to Email (SMTP via nodemailer) and WhatsApp (Meta Cloud API
// or generic webhook). Both channels are optional and gracefully degrade when
// credentials are missing.

let nodemailer = null;
try {
  // Optional dep — only required if EMAIL_ENABLED=true
  // eslint-disable-next-line import/no-extraneous-dependencies
  nodemailer = (await import("nodemailer")).default;
} catch {
  nodemailer = null;
}

const fmtDeg = (n) => (typeof n === "number" ? `${n.toFixed(1)}°C` : "—");
const escapeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export class Notifier {
  constructor({ env, store, stateStore }) {
    this.env = env;
    this.store = store;
    this.stateStore = stateStore || null;
    this.emailTransport = null;

    // Precedence: saved subscribers > .env recipients. The store returns
    // `subscribers: null` when the file had no subscribers section (or no
    // file at all), in which case we seed from .env.
    const savedSubs = stateStore?.getSnapshot?.()?.subscribers;
    this.subscribers = savedSubs
      ? {
          emails: [...(savedSubs.emails || [])],
          whatsapp: [...(savedSubs.whatsapp || [])]
        }
      : {
          emails: [...(env.email.recipients || [])],
          whatsapp: [...(env.whatsapp.recipients || [])]
        };
    this.dispatchLog = [];

    if (env.email.enabled && nodemailer && env.email.host) {
      try {
        this.emailTransport = nodemailer.createTransport({
          host: env.email.host,
          port: env.email.port,
          secure: env.email.secure,
          auth: env.email.user
            ? { user: env.email.user, pass: env.email.pass }
            : undefined
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`[Notifier] SMTP init failed: ${error.message}`);
      }
    }
  }

  getSubscribers() {
    return {
      emails: [...this.subscribers.emails],
      whatsapp: [...this.subscribers.whatsapp]
    };
  }

  addEmail(address) {
    const trimmed = String(address || "").trim().toLowerCase();
    if (!trimmed || !trimmed.includes("@")) return false;
    if (!this.subscribers.emails.includes(trimmed)) this.subscribers.emails.push(trimmed);
    this._persist();
    return true;
  }

  removeEmail(address) {
    const trimmed = String(address || "").trim().toLowerCase();
    this.subscribers.emails = this.subscribers.emails.filter((e) => e !== trimmed);
    this._persist();
    return true;
  }

  addWhatsapp(number) {
    const trimmed = String(number || "").replace(/\s+/g, "");
    if (!trimmed) return false;
    if (!this.subscribers.whatsapp.includes(trimmed)) this.subscribers.whatsapp.push(trimmed);
    this._persist();
    return true;
  }

  removeWhatsapp(number) {
    const trimmed = String(number || "").replace(/\s+/g, "");
    this.subscribers.whatsapp = this.subscribers.whatsapp.filter((n) => n !== trimmed);
    this._persist();
    return true;
  }

  _persist() {
    if (!this.stateStore) return;
    this.stateStore.update({
      subscribers: {
        emails: [...this.subscribers.emails],
        whatsapp: [...this.subscribers.whatsapp]
      }
    });
  }

  getStatus() {
    return {
      email: {
        enabled: this.env.email.enabled && Boolean(this.emailTransport),
        configured: Boolean(this.env.email.host && (nodemailer || true)),
        host: this.env.email.host || null,
        from: this.env.email.from,
        nodemailerAvailable: Boolean(nodemailer)
      },
      whatsapp: {
        enabled: this.env.whatsapp.enabled,
        provider: this.env.whatsapp.provider,
        campaignName: this.env.whatsapp.campaignName || null,
        configured:
          Boolean(this.env.whatsapp.apiUrl && this.env.whatsapp.apiToken) &&
          (this.env.whatsapp.provider !== "aisensy" || Boolean(this.env.whatsapp.campaignName))
      },
      subscribers: this.getSubscribers(),
      recentDispatches: this.dispatchLog.slice(0, 20)
    };
  }

  async dispatch(alert) {
    const results = { email: null, whatsapp: null };
    try {
      results.email = await this._sendEmail(alert);
    } catch (e) {
      results.email = { ok: false, error: e.message };
    }
    try {
      results.whatsapp = await this._sendWhatsapp(alert);
    } catch (e) {
      results.whatsapp = { ok: false, error: e.message };
    }
    const entry = {
      id: `dispatch-${alert.id}`,
      alertId: alert.id,
      deviceId: alert.deviceId,
      kind: alert.kind,
      at: new Date().toISOString(),
      results
    };
    this.dispatchLog.unshift(entry);
    if (this.dispatchLog.length > 100) this.dispatchLog.length = 100;
    return entry;
  }

  // Manual test path — uses sample alert payload, hits live recipients
  async sendTest({ channel = "all", overrides = {} } = {}) {
    const sample = {
      id: `test-${Date.now()}`,
      kind: "overheat",
      severity: "critical",
      deviceId: "G0991",
      assetId: "G0991",
      assetTag: "F1",
      assetName: "Pipe Furnace",
      location: { org: "sgl", plant: "unit_1" },
      mv: 950,
      sp: 900,
      delta: 50,
      unit: "degC",
      sustainedMinutes: 5,
      thresholdDeg: 20,
      timestamp: new Date().toISOString(),
      subject: "TEST — OVERHEAT ALERT — F1 (Pipe Furnace)",
      message: "This is a test alert from PlantiqX IoT Monitor.",
      ...overrides
    };
    const result = { email: null, whatsapp: null };
    if (channel === "email" || channel === "all") {
      result.email = await this._sendEmail(sample);
    }
    if (channel === "whatsapp" || channel === "all") {
      result.whatsapp = await this._sendWhatsapp(sample);
    }
    return { sample, result };
  }

  async _sendEmail(alert) {
    if (!this.env.email.enabled) return { ok: false, skipped: "email_disabled" };
    if (!this.emailTransport) return { ok: false, skipped: "transport_unavailable" };
    if (!this.subscribers.emails.length) return { ok: false, skipped: "no_recipients" };

    const html = renderAlertEmailHtml(alert);
    const text = renderAlertEmailText(alert);

    const info = await this.emailTransport.sendMail({
      from: this.env.email.from,
      replyTo: this.env.email.replyTo || undefined,
      to: this.subscribers.emails.join(","),
      subject: alert.subject,
      text,
      html
    });
    return { ok: true, messageId: info.messageId, accepted: info.accepted };
  }

  async _sendWhatsapp(alert) {
    if (!this.env.whatsapp.enabled) return { ok: false, skipped: "whatsapp_disabled" };
    if (!this.env.whatsapp.apiUrl || !this.env.whatsapp.apiToken) {
      return { ok: false, skipped: "missing_credentials" };
    }
    if (this.env.whatsapp.provider === "aisensy" && !this.env.whatsapp.campaignName) {
      return { ok: false, skipped: "missing_campaign_name" };
    }
    if (!this.subscribers.whatsapp.length) return { ok: false, skipped: "no_recipients" };

    const messageText = renderAlertWhatsappText(alert);
    const provider = this.env.whatsapp.provider || "meta";

    const results = [];
    for (const number of this.subscribers.whatsapp) {
      try {
        if (provider === "aisensy") {
          const params = [
            (alert.severity || "").toUpperCase(),
            (alert.kind || "").replace("_", " ").toUpperCase(),
            alert.assetTag || alert.deviceId || "",
            alert.assetName || "Furnace",
            fmtDeg(alert.mv),
            fmtDeg(alert.sp),
            fmtDeg(alert.delta),
            String(alert.sustainedMinutes ?? "—")
          ];
          const body = {
            apiKey: this.env.whatsapp.apiToken,
            campaignName: this.env.whatsapp.campaignName || this.env.whatsapp.templateName,
            destination: number,
            userName: this.env.whatsapp.senderUserName || "PlantiqX",
            templateParams: params,
            source: "plantiqx-iot-monitor",
            media: {},
            buttons: [],
            carouselCards: [],
            location: {}
          };
          const response = await fetch(this.env.whatsapp.apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
          const json = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(json?.message || json?.error || `HTTP ${response.status}`);
          }
          results.push({ to: number, ok: true, response: json });
        } else if (provider === "meta") {
          const body = this.env.whatsapp.templateName
            ? {
                messaging_product: "whatsapp",
                to: number,
                type: "template",
                template: {
                  name: this.env.whatsapp.templateName,
                  language: { code: "en" },
                  components: [
                    {
                      type: "body",
                      parameters: [
                        { type: "text", text: alert.assetTag || alert.deviceId },
                        { type: "text", text: alert.assetName || "Furnace" },
                        { type: "text", text: fmtDeg(alert.mv) },
                        { type: "text", text: fmtDeg(alert.sp) },
                        { type: "text", text: fmtDeg(alert.delta) },
                        { type: "text", text: String(alert.sustainedMinutes ?? "—") }
                      ]
                    }
                  ]
                }
              }
            : {
                messaging_product: "whatsapp",
                to: number,
                type: "text",
                text: { body: messageText }
              };

          const response = await fetch(this.env.whatsapp.apiUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.env.whatsapp.apiToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
          });
          const json = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(json.error?.message || `HTTP ${response.status}`);
          results.push({ to: number, ok: true, id: json?.messages?.[0]?.id || null });
        } else {
          // generic webhook
          const response = await fetch(this.env.whatsapp.apiUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.env.whatsapp.apiToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ to: number, message: messageText, alert })
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          results.push({ to: number, ok: true });
        }
      } catch (error) {
        results.push({ to: number, ok: false, error: error.message });
      }
    }
    return { ok: results.every((r) => r.ok), results };
  }
}

// === Templates ===

const isAbsoluteKind = (kind) => kind === "high_limit" || kind === "low_limit";

const deviationLabel = (kind) => {
  if (kind === "high_limit") return "Over high limit by";
  if (kind === "low_limit") return "Under low limit by";
  return "Deviation from SP";
};

const thresholdLabel = (kind) => {
  if (kind === "high_limit") return "High limit";
  if (kind === "low_limit") return "Low limit";
  return "Threshold";
};

const recommendation = (kind) => {
  switch (kind) {
    case "high_limit":
      return "MV crossed the absolute high limit. Check for thermocouple runaway, stuck heater contactor, or operator-set high SP.";
    case "low_limit":
      return "MV fell below the absolute low limit while the furnace is operational. Verify heater health and thermocouple wiring.";
    case "undercool":
      return "MV is not reaching SP. Verify heater output, recipe ramp, and thermocouple calibration.";
    default:
      return "Investigate the furnace control loop, verify thermocouple integrity, and confirm the recipe set point is correct.";
  }
};

function renderAlertEmailText(alert) {
  return [
    `PlantiqX IoT Monitor — ${alert.subject}`,
    "",
    `Severity:        ${alert.severity?.toUpperCase()}`,
    `Furnace:         ${alert.assetTag || ""} (${alert.assetName || ""})`,
    `Asset ID:        ${alert.assetId}`,
    `Plant:           ${alert.location?.org || ""}/${alert.location?.plant || ""}`,
    `Measured (MV):   ${fmtDeg(alert.mv)}`,
    `Set Point (SP):  ${fmtDeg(alert.sp)}`,
    `${thresholdLabel(alert.kind)}:        ${fmtDeg(alert.threshold ?? alert.thresholdDeg)}`,
    `${deviationLabel(alert.kind)}: ${fmtDeg(alert.delta)}`,
    `Sustained:       ${alert.sustainedMinutes} minute(s)`,
    `Detected at:     ${alert.timestamp}`,
    "",
    alert.message,
    "",
    recommendation(alert.kind),
    "",
    "— Automated message from PlantiqX IoT Monitor"
  ].join("\n");
}

function renderAlertEmailHtml(alert) {
  // Severity palette aligned with PlantiqX in-app theme
  const palette =
    alert.severity === "critical"
      ? { accent: "#dc2626", accentDark: "#b42318", chipBg: "#fee2e2", chipFg: "#991b1b" }
      : alert.severity === "warning"
      ? { accent: "#d69b14", accentDark: "#b8860b", chipBg: "#fef3c7", chipFg: "#92400e" }
      : { accent: "#5925DC", accentDark: "#4020DF", chipBg: "#ede7ff", chipFg: "#4020DF" };

  const brand = { primary: "#5925DC", primaryDark: "#4020DF", accent: "#FF8700" };

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f6f4fb;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1b1235;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 28px rgba(89,37,220,0.10);border:1px solid #e8e3f5;">

        <!-- Brand band -->
        <tr><td style="padding:18px 28px 14px 28px;background:linear-gradient(135deg,${brand.primary} 0%,${brand.primaryDark} 100%);">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.4px;">PlantiqX</td>
              <td align="right" style="color:rgba(255,255,255,0.78);font-size:11px;letter-spacing:1.4px;text-transform:uppercase;">IoT Monitor</td>
            </tr>
          </table>
        </td></tr>

        <!-- Severity headline -->
        <tr><td style="padding:24px 28px 8px 28px;background:#ffffff;">
          <div style="display:inline-block;padding:5px 12px;border-radius:999px;background:${palette.chipBg};color:${palette.chipFg};font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;">
            ${escapeHtml((alert.severity || "info").toUpperCase())} · ${escapeHtml(((alert.kind || "alert") + "").replace(/_/g, " ").toUpperCase())}
          </div>
          <h1 style="margin:14px 0 4px 0;font-size:22px;font-weight:700;color:#1b1235;line-height:1.25;">${escapeHtml(alert.subject || "Alert triggered")}</h1>
          <p style="margin:0 0 0 0;font-size:14px;line-height:1.55;color:#5d5673;">${escapeHtml(alert.message || "")}</p>
        </td></tr>

        <!-- Reading cards -->
        <tr><td style="padding:18px 28px 4px 28px;background:#ffffff;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:8px 0;">
            <tr>
              ${readingCard("Measured (MV)", fmtDeg(alert.mv), brand.primary)}
              ${
                isAbsoluteKind(alert.kind)
                  ? readingCard(thresholdLabel(alert.kind), fmtDeg(alert.threshold ?? alert.thresholdDeg), brand.accent)
                  : readingCard("Setpoint (SP)", fmtDeg(alert.sp), brand.accent)
              }
              ${readingCard(deviationLabel(alert.kind), fmtDeg(alert.delta), palette.accent)}
            </tr>
          </table>
        </td></tr>

        <!-- Details table -->
        <tr><td style="padding:18px 28px 8px 28px;background:#ffffff;">
          <div style="font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#8b85a4;margin-bottom:8px;">Event details</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13.5px;border:1px solid #e8e3f5;border-radius:10px;overflow:hidden;">
            ${row("Furnace", `<strong>${escapeHtml(alert.assetTag || "")}</strong> &middot; ${escapeHtml(alert.assetName || "")}`)}
            ${row("Asset ID", `<code style="background:#f6f4fb;padding:1px 6px;border-radius:4px;font-size:12px;color:#4020DF;">${escapeHtml(alert.assetId || alert.deviceId)}</code>`)}
            ${row("Plant", `${escapeHtml(alert.location?.org || "—")} / ${escapeHtml(alert.location?.plant || "—")}`)}
            ${row("Sustained", `${escapeHtml(String(alert.sustainedMinutes ?? "—"))} minute(s)`)}
            ${row("Detected at", escapeHtml(new Date(alert.timestamp || Date.now()).toLocaleString()))}
          </table>
        </td></tr>

        <!-- Recommendation -->
        <tr><td style="padding:18px 28px 22px 28px;background:#ffffff;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf8ff;border:1px solid #e8e3f5;border-left:4px solid ${palette.accent};border-radius:10px;">
            <tr><td style="padding:14px 16px;">
              <div style="font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${palette.accentDark};margin-bottom:4px;">Recommended action</div>
              <div style="font-size:13.5px;line-height:1.55;color:#3f3759;">${escapeHtml(recommendation(alert.kind))}</div>
            </td></tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:14px 28px 22px 28px;background:#faf8ff;border-top:1px solid #e8e3f5;font-size:11.5px;color:#8b85a4;text-align:center;">
          Automated message from <strong style="color:${brand.primary};">PlantiqX IoT Monitor</strong> &middot; Do not reply<br />
          Manage recipients and alert rules from the dashboard.
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function row(label, value) {
  return `<tr style="border-bottom:1px solid #f1eefa;">
    <td style="padding:10px 14px;color:#6b6685;width:140px;background:#faf8ff;font-weight:600;font-size:12.5px;">${escapeHtml(label)}</td>
    <td style="padding:10px 14px;color:#1b1235;">${value}</td>
  </tr>`;
}

function readingCard(label, value, color) {
  return `<td valign="top" align="center" style="background:#faf8ff;border:1px solid #e8e3f5;border-radius:10px;padding:12px 8px;">
    <div style="font-size:10.5px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#8b85a4;">${escapeHtml(label)}</div>
    <div style="margin-top:4px;font-size:20px;font-weight:700;color:${color};line-height:1.1;">${value}</div>
  </td>`;
}

function renderAlertWhatsappText(alert) {
  const icon =
    alert.kind === "overheat" || alert.kind === "high_limit"
      ? "🔥"
      : alert.kind === "undercool" || alert.kind === "low_limit"
        ? "❄️"
        : "⚠️";
  const lines = [
    `${icon} *PlantiqX Alert* — ${alert.severity?.toUpperCase()}`,
    "",
    `*${alert.subject}*`,
    "",
    `• Furnace: ${alert.assetTag || ""} (${alert.assetName || ""})`,
    `• Asset ID: ${alert.assetId}`,
    `• Plant: ${alert.location?.org || ""}/${alert.location?.plant || ""}`,
    `• MV: ${fmtDeg(alert.mv)}`
  ];
  if (!isAbsoluteKind(alert.kind)) {
    lines.push(`• SP: ${fmtDeg(alert.sp)}`);
  }
  lines.push(
    `• ${thresholdLabel(alert.kind)}: ${fmtDeg(alert.threshold ?? alert.thresholdDeg)}`,
    `• ${deviationLabel(alert.kind)}: ${fmtDeg(alert.delta)}`,
    `• Sustained: ${alert.sustainedMinutes} min`,
    `• At: ${alert.timestamp}`,
    "",
    alert.message,
    "",
    "_Automated — PlantiqX IoT Monitor_"
  );
  return lines.join("\n");
}
