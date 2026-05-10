import verifyAdmin from "./_verifyAdmin.js";
import { confirmBookingCore } from "./_confirmBookingCore.js";



export default async function handler(req, res) {
  try {
    await verifyAdmin(req);
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false });
  }

  try {
    const result = await confirmBookingCore({
      bookingId: req.body?.bookingId,
      sendCustomerEmail: true
    });
    return res.status(result.statusCode).json(result.body);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: err.message });
  }
}
