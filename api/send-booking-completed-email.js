import { createClient } from "@supabase/supabase-js";
import { sendBookingEmail } from "./_sendEmail.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { booking_id } = req.body;
    if (!booking_id) return res.status(400).json({ error: "Missing booking_id" });

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data: booking } = await supabase
      .from("bookings")
      .select(`customers:customer_id ( full_name, email )`)
      .eq("id", booking_id)
      .single();

    await sendBookingEmail({
  to: booking.customers.email,
  subject: "Moon Auto Detailing — Thank You!",
  html: `
    <h2>Thank you for choosing Moon Auto Detailing</h2>

    <p>Hi ${booking.customers.full_name},</p>

    <p>Your detailing service is now complete. We truly appreciate your trust in us and hope you love the results.</p>

    <p>If you would like to keep your vehicle looking its best year-round, our monthly detailing program is the easiest way to stay on a consistent schedule:</p>

    <p>
      <a href="https://moonautodetailing.com/monthly-detailing-service">
        View Monthly Detailing Plans
      </a>
    </p>

    <p>If you were happy with your service, a review would mean a lot and helps our small business grow:</p>

    <p>
      <a href="https://g.page/r/Cf7sALGmq14REAE/review">
        Leave a Google Review
      </a>
    </p>

    <p>Thank you again for your support.</p>
    <p>Moon Auto Detailing</p>
  `
});


    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
