// Scheduled jobs: Vercel sends "Authorization: Bearer <CRON_SECRET>" with every cron run when
// CRON_SECRET is set. That header is the only proof accepted — the x-vercel-cron header can be
// sent by anyone, so it is ignored. With no CRON_SECRET configured, every request is refused.
import crypto from "crypto";

export function isCronRequest(req, secret = process.env.CRON_SECRET) {
  if (!secret) return false;
  const given = Buffer.from(String(req.headers?.authorization || ""));
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
