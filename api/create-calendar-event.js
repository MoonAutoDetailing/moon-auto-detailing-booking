export const config = {
  runtime: "nodejs"
};

import { google } from "googleapis";

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function readJson(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  return JSON.parse(data || "{}");
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).end("Method Not Allowed");
      return;
    }

    const adminSecret = mustGetEnv("ADMIN_SECRET");
    if (req.headers["x-admin-secret"] !== adminSecret) {
      res.status(401).end("Unauthorized");
      return;
    }

    const body = await readJson(req);
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
      res.status(400).end("Missing required fields");
      return;
    }

    const calendarId = mustGetEnv("GOOGLE_CALENDAR_ID");

    const serviceAccount = JSON.parse(
      Buffer.from(
        mustGetEnv("GOOGLE_SERVICE_ACCOUNT_JSON"),
        "base64"
      ).toString("utf8")
    );

    const auth = new google.auth.JWT({
      client_email: serviceAccount.client_email,
      private_key: serviceAccount.private_key,
      scopes: ["https://www.googleapis.com/auth/calendar"]
    });

    const calendar = google.calendar({ version: "v3", auth });

    const event = {
      summary: customer_name,
      location: address,
      description: [
        service_text,
        vehicle_text && `Vehicle: ${vehicle_text}`,
        customer_phone && `Phone: ${customer_phone}`
      ].filter(Boolean).join("\n"),
      start: { dateTime: start_iso, timeZone: "America/New_York" },
      end: { dateTime: end_iso, timeZone: "America/New_York" }
    };

    const created = await calendar.events.insert({
      calendarId,
      requestBody: event
    });

    res.status(200).json({
      ok: true,
      google_event_id: created.data.id
    });

  } catch (err) {
    console.error("CALENDAR ERROR:", err);
    res.status(500).json({
      ok: false,
      message: err.message
    });
  }
}
