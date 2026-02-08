console.log(
  "ENV CHECK",
  !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.length
);

console.log("CALENDAR AUTH PATCH v1 LOADED");

// /api/create-calendar-event.js
const { google } = require("googleapis");

function decodeServiceAccountEnv() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!raw) return null;

  // Primary: Base64-encoded JSON key
  // Fallback: raw JSON (in case it was pasted directly)
  let jsonString = raw;
  try {
    // If it's base64, this will usually produce a JSON-looking string
    const decoded = Buffer.from(raw, "base64").toString("utf8").trim();
    if (decoded.startsWith("{") && decoded.includes("client_email")) {
      jsonString = decoded;
    }
  } catch (e) {
    // ignore, we'll try raw JSON next
  }

  let creds;
  try {
    creds = JSON.parse(jsonString);
  } catch (e) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is present but not valid JSON (after base64 decode fallback)."
    );
  }

  if (!creds.client_email) {
    throw new Error("Service account JSON missing client_email.");
  }
  if (!creds.private_key) {
    throw new Error("Service account JSON missing private_key.");
  }

  // Normalize private_key newlines (common Vercel env issue)
  creds.private_key = creds.private_key.replace(/\\n/g, "\n");

  return creds;
}

function getJwtClient() {
  // Prefer the single source of truth: GOOGLE_SERVICE_ACCOUNT_JSON
  const creds = decodeServiceAccountEnv();

  if (creds) {
    return new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });
  }

  // Optional fallback to legacy vars if JSON env var isn't set
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY;

  if (key) key = key.replace(/\\n/g, "\n");

  if (!email || !key) {
    throw new Error(
      "No service account credentials found. Set GOOGLE_SERVICE_ACCOUNT_JSON (base64 JSON) or legacy GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY."
    );
  }

  return new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const adminSecret = process.env.ADMIN_SECRET;
    const providedSecret =
      req.headers["x-admin-secret"] || req.body?.adminSecret;

    if (!adminSecret || providedSecret !== adminSecret) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const calendarId = process.env.GOOGLE_CALENDAR_ID;
    if (!calendarId) {
      return res
        .status(500)
        .json({ ok: false, message: "Missing GOOGLE_CALENDAR_ID" });
    }

    const { summary, description, location, startISO, endISO } = req.body || {};

    // Keep your existing datetime logic elsewhere; this function just expects valid ISO strings
    if (!summary || !startISO || !endISO) {
      return res.status(400).json({
        ok: false,
        message: "Missing required fields: summary, startISO, endISO",
      });
    }

    const auth = getJwtClient();
    const calendar = google.calendar({ version: "v3", auth });

    // Ensure auth is actually usable before insert (helps surface key issues cleanly)
    await auth.authorize();

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
    // Do NOT dump private keys. Give enough to diagnose missing wiring.
    const message = err?.message || "Unknown error";
    return res.status(500).json({
      ok: false,
      message,
      hint:
        message.includes("No key or keyFile set") ||
        message.includes("private_key") ||
        message.includes("credentials")
          ? "Credential wiring issue: verify GOOGLE_SERVICE_ACCOUNT_JSON is base64 of the full key JSON (including private_key), and that private_key newlines are preserved (\\n -> actual newlines)."
          : undefined,
    });
  }
};
