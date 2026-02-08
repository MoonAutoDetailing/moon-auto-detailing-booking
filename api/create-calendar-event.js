const { google } = require("googleapis");

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false });
  }

  try {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON missing");

    const creds = JSON.parse(
      Buffer.from(raw, "base64").toString("utf8")
    );

    const auth = new google.auth.JWT(
      creds.client_email,
      null,
      creds.private_key.replace(/\\n/g, "\n"),
      ["https://www.googleapis.com/auth/calendar"]
    );

    await auth.authorize();

    const calendar = google.calendar({ version: "v3", auth });

    const event = {
      summary: req.body.summary,
      description: req.body.description,
      location: req.body.location,
      start: { dateTime: req.body.startISO },
      end: { dateTime: req.body.endISO },
    };

    const response = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      requestBody: event,
    });

    res.status(200).json({
      ok: true,
      htmlLink: response.data.htmlLink,
    });
  } catch (err) {
    console.error("CALENDAR ERROR:", err.message);
    res.status(500).json({ ok: false, message: err.message });
  }
}

module.exports = handler;

/**
 * ⬇️ THIS IS THE CRITICAL LINE ⬇️
 * It MUST be exactly this shape.
 */
module.exports.config = {
  runtime: "nodejs",
};
