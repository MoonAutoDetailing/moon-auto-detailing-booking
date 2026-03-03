import { checkAvailability } from "./_availability.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { start, end } = req.body;
    if (!start || !end) {
      return res.status(400).json({ available: false });
    }

    const isAvailable = await checkAvailability(start, end);
    return res.status(200).json({ available: isAvailable });

  } catch (err) {
    console.error("availability check error:", err);
    return res.status(500).json({ available: false });
  }
}
