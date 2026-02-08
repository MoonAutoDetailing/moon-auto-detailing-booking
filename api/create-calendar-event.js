const { google } = require("googleapis");

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    // auth gate (keep as-is)
    const adminSecret = process.env.ADMIN_SECRET;
    const providedSecret = req.headers["x-admin-secret"] || req.body?.adminSecret;
    if (!adminSecret || providedSecret !== adminSecret) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const calendarId = process.env.GOOGLE_CALENDAR_ID;
    if (!calendarId) {
      return res.status(500).json({ ok: false, message: "Missing GOOGLE_CALENDAR_ID" });
    }

    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

    // ---- SAFE DIAGNOSTICS (no secrets) ----
    const diag = {
      hasServiceAccountEnv: !!raw,
      serviceAccountEnvLength: raw ? raw.length : 0,
      decodedLooksJson: false,
      parsedHasClientEmail: false,
      privateKeyLength: 0,
    };

    if (!raw) {
      return res.status(500).json({
        ok: false,
        message: "Missing GOOGLE_SERVICE_ACCOUNT_JSON",
        diag,
      });
    }

    // Base64 decode
    let decoded;
    try {
      decoded = Buffer.from(raw, "base64").toString("utf8");
      const trimmed = decoded.trimStart();
      diag.decodedLooksJson = trimmed.startsWith("{");
    } catch (e) {
      return res.status(500).json({
        ok: false,
        message: "Failed to base64-decode GOOGLE_SERVICE_ACCOUNT_JSON",
        diag,
      });
    }

    // Parse JSON
    let creds;
    try {
      creds = JSON.parse(decoded);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        message: "Decoded GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON",
        diag,
      });
    }

    diag.parsedHasClientEmail = !!creds.client_email;
    const pk = (creds.private_key || "").replace(/\\n/g, "\n");
    diag.privateKeyLength = pk.length;

    if (!creds.client_email) {
      return res.status(500).json({
        ok: false,
        message: "Service account JSON missing client_email",
        diag,
      });
    }
    if (!pk || pk.length < 100) {
      return res.status(500).json({
        ok: false,
        message: "Service account JSON missing/empty private_key (or too short)",
        diag,
      });
    }

    // JWT: positional constructor to remove option-shape ambiguity
    const auth = new google.auth.JWT(
      creds.client_email,
      null,
      pk,
      ["https://www.googleapis.com/auth/calendar"]
    );

    await auth.authorize();

    const calendar = google.calendar({ version: "v3", auth });

    const { summary, description, location, startISO, endISO } = req.body || {};
    if (!summary || !startISO || !endISO) {
      return res.status(400).json({
        ok: false,
        message: "Missing required fields: summary, startISO, endISO",
      });
    }

    const event = {
      summary,
      description: description || "",
      location: location || "",
      start: { dateTime: startISO },
      end: { dateTime: endISO },
    };

    const insertResponse = await calendar.events.insert({
      calendarId,
      requestBody: event,
    });

    return res.status(200).json({
      ok: true,
      eventId: insertResponse.data.id,
      htmlLink: insertResponse.data.htmlLink,
    });
  } catch (err) {
    // include only safe diagnostics here (no secrets)
    return res.status(500).json({
      ok: false,
      message: err?.message || "Unknown error",
    });
  }
}

module.exports = handler;
