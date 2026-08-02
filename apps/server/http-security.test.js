const test = require("node:test");
const assert = require("node:assert/strict");

const { FixedWindowRateLimiter, clientAddress } = require("./http-security");

test("fixed-window limiter isolates keys and resets after the window", () => {
  let clock = 1_000;
  const limiter = new FixedWindowRateLimiter(() => clock);
  limiter.assert("rooms:one", 2, 10_000);
  limiter.assert("rooms:one", 2, 10_000);
  assert.throws(() => limiter.assert("rooms:one", 2, 10_000), (error) => error.status === 429 && error.retryAfterSec === 10);
  limiter.assert("rooms:two", 2, 10_000);
  clock = 11_000;
  limiter.assert("rooms:one", 2, 10_000);
});

test("client address accepts a valid proxy address and rejects spoofed text", () => {
  assert.equal(clientAddress({ headers: { "x-forwarded-for": "203.0.113.8, 10.0.0.2" }, socket: {} }), "203.0.113.8");
  assert.equal(clientAddress({ headers: { "x-forwarded-for": "not-an-ip" }, socket: { remoteAddress: "::ffff:127.0.0.1" } }), "127.0.0.1");
});
