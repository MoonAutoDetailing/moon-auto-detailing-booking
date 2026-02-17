import { createClient } from "@supabase/supabase-js";
import verifyAdmin from "./_verifyAdmin.js";
import { sendBookingDeniedEmailCore } from "../lib/email/sendBookingDeniedEmail.js";


export default async function handler(req, res) {
  await verifyAdmin(req);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { bookingId } = req.body;
  if (!bookingId) {
    return res.status(400).json({ error: "Missing bookingId" });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  console.log("DENY: updating booking status", bookingId);

  await supabase
    .from("bookings")
    .update({ status: "denied" })
    .eq("id", bookingId);

  console.log("DENY: status updated, sending email");

  await sendBookingDeniedEmailCore(bookingId);

  console.log("DENY: email send finished");

  return res.status(200).json({ ok: true });
}


  } catch (err) {
    console.error("admin-deny-booking error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
