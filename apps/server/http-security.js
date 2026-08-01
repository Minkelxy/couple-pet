const net = require("node:net");

class FixedWindowRateLimiter {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.buckets = new Map();
  }

  assert(key, limit, windowMs) {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (this.buckets.size > 10_000) {
      for (const [candidate, value] of this.buckets) {
        if (value.resetAt <= now) this.buckets.delete(candidate);
      }
    }
    if (bucket.count > limit) {
      const error = Object.assign(new Error("请求过于频繁，请稍后再试"), {
        status: 429,
        retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
      });
      throw error;
    }
  }
}

function clientAddress(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (net.isIP(forwarded)) return forwarded;
  const direct = String(req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
  return net.isIP(direct) ? direct : "unknown";
}

module.exports = { FixedWindowRateLimiter, clientAddress };
