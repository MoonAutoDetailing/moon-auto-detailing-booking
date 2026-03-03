const buckets = new Map();

function getIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

export function rateLimit(req, { key, limit, windowMs }) {
  const ip = getIp(req);
  const now = Date.now();
  const bucketKey = `${key}:${ip}`;

  const arr = buckets.get(bucketKey) || [];
  const cutoff = now - windowMs;
  const filtered = arr.filter((ts) => ts > cutoff);

  if (filtered.length >= limit) {
    const oldest = filtered[0];
    const retryAfterMs = Math.max(0, oldest + windowMs - now);
    const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
    buckets.set(bucketKey, filtered);
    return { allowed: false, retryAfterSeconds };
  }

  filtered.push(now);
  buckets.set(bucketKey, filtered);
  return { allowed: true, retryAfterSeconds: 0 };
}
