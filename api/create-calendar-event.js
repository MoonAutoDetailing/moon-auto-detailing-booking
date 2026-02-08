import { google } from "googleapis";
import fs from "fs";
import path from "path";
import os from "os";

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function safeJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (e) {
        reject(e);
      }
    });
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end("Method Not Allowed");
    }

    // Lightweight protection (matches your admin header approach)
    const adminSecret = mustGetEnv("ADMIN_SECRET");
    const headerSecret = req.headers["x-admin-secret"];
    if (!headerSecret || headerSecret !== adminSecret) {
      res.statusCode = 401;
      return res.end("Unauthorized");
    }

    const body = await safeJson(req);

    const {
      customer_name,
      customer_phone,
      address,
      vehicle_text,
      service_text,
      start_iso,
      end_iso
    } = body;

    if (!customer_name || !address || !service_text || !start_iso || !end_iso) {
      res.statusCode = 400;
      return res.end("Missing required fields");
    }

    const calendarId = mustGetEnv("GOOGLE_CALENDAR_ID");
const serviceAccountJson = Buffer.from(
  mustGetEnv("GOOGLE_SERVICE_ACCOUNT_JSON"),
  "base64"
).toString("utf8");

const tmpPath = path.join(os.tmpdir(), "gsa.json");
fs.writeFileSync(tmpPath, serviceAccountJson);

const auth = new google.auth.JWT({
  keyFile: tmpPath,
  scopes: ["https://www.googleapis.com/auth/calendar"]
});

await auth.authorize();

    const calendar = google.calendar({ version: "v3", auth });

    // Title format: customer name (matches your screenshot)
    const summary = customer_name;

    // Description: include everything you said "Yes" to
    const descriptionLines = [
      service_text,
      vehicle_text ? `Vehicle: ${vehicle_text}` : null,
      customer_phone ? `Phone: ${customer_phone}` : null
    ].filter(Boolean);

    const event = {
      summary,
      location: address,
      description: descriptionLines.join("\n"),
      start: {
        dateTime: start_iso,
        timeZone: "America/New_York"
      },
      end: {
        dateTime: end_iso,
        timeZone: "America/New_York"
      },
      reminders: {
        useDefault: false,
        overrides: [{ method: "popup", minutes: 30 }]
      }
    };

    const created = await calendar.events.insert({
      calendarId,
      requestBody: event
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({
        ok: true,
        google_event_id: created.data.id
      })
    );
} catch (err) {
  console.error("CALENDAR ERROR:", err);

  res.statusCode = 500;
  res.setHeader("Content-Type", "application/json");
  return res.end(
    JSON.stringify({
      ok: false,
      message: err?.message || "Unknown error",
      code: err?.code,
      errors: err?.errors
    })
  );
}
