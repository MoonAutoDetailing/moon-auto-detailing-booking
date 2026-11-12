import { google } from "googleapis";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    // Admin session is checked in api/router.js (ADMIN_REQUIRED); the old shared
    // ADMIN_SECRET header is no longer accepted.

    const calendarId = process.env.GOOGLE_CALENDAR_ID.trim();
    if (!calendarId) {
      return res
        .status(500)
        .json({ ok: false, message: "Missing GOOGLE_CALENDAR_ID" });
    }

    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
      return res.status(500).json({
        ok: false,
        message: "Missing GOOGLE_SERVICE_ACCOUNT_JSON",
      });
    }

    // Decode + parse service account
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const creds = JSON.parse(decoded);

    const privateKey = creds.private_key?.replace(/\\n/g, "\n");
    if (!creds.client_email || !privateKey) {
      return res.status(500).json({
        ok: false,
        message: "Invalid service account credentials",
      });
    }

    // Google auth (JWT)
    const auth = new google.auth.JWT(
      creds.client_email,
      null,
      privateKey,
      ["https://www.googleapis.com/auth/calendar"]
    );

    await auth.authorize();

    const calendar = google.calendar({ version: "v3", auth });

    const { summary, description, location, startISO, endISO } = req.body;

    if (!summary || !startISO || !endISO) {
      return res.status(400).json({
        ok: false,
        message: "Missing required fields",
      });
    }

    const event = {
      summary,
      description: description || "",
      location: location || "",
      start: { dateTime: startISO },
      end: { dateTime: endISO },
    };

    const response = await calendar.events.insert({
      calendarId,
      requestBody: event,
    });

    return res.status(200).json({
      ok: true,
      eventId: response.data.id,
      htmlLink: response.data.htmlLink,
    });
  } catch (err) {
    console.error("CALENDAR ERROR:", err);
    return res.status(500).json({
      ok: false,
      message: err.message || "Calendar error",
    });
  }
}
