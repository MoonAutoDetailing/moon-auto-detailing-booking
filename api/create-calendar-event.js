const { google } = require("googleapis");

const handler = async (req, res) => {
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

    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
      throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON");
    }

    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const creds = JSON.parse(decoded);

    const auth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });

    await auth.authorize();

    const calendar = google.calendar({ version: "v3", auth });

    const { summary, description, location, startISO, endISO } = req.body;

    const event = {
      summary,
      description,
      location,
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
    return res.status(500).json({
      ok: false,
      message: err.message,
    });
  }
};

module.exports = handler;

module.exports.config = {
  runtime: "nodejs",
};
