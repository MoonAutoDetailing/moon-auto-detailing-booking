import crypto from "crypto";

export function verifyAdmin(req) {
  const token = req.headers["x-admin-session"];
  if (!token) return false;

  const [expires, signature] = token.split(".");
  if (!expires || !signature) return false;

  if (Date.now() > Number(expires)) return false;

  const expected = crypto
    .createHmac("sha256", process.env.SESSION_SECRET)
    .update(expires)
    .digest("hex");

  return signature === expected;
}
