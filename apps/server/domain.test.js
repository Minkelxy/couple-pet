const test = require("node:test");
const assert = require("node:assert/strict");
const { PetDomain, initialDb } = require("./domain");

function pair(now = () => Date.now()) {
  const domain = new PetDomain(initialDb(), now);
  const room = domain.createRoom();
  const a = domain.bind(room.inviteCodes[0], "小雨");
  const b = domain.bind(room.inviteCodes[1], "阿岚");
  return { domain, a: domain.authenticate(a.token), b: domain.authenticate(b.token) };
}

test("two invite codes bind to the same room", () => {
  const { domain, a, b } = pair();
  assert.equal(a.room.id, b.room.id);
  assert.equal(domain.snapshot(a).users.length, 2);
});
test("event IDs are idempotent", () => {
  let clock = 1_700_000_000_000;
  const { domain, a } = pair(() => clock);
  const input = { id: "event_unique_001", type: "CARE", createdAt: clock, payload: { action: "pet" } };
  const first = domain.submit(a, input);
  const second = domain.submit(a, input);
  assert.equal(second.duplicate, true);
  assert.equal(second.state.growth, first.state.growth);
  assert.equal(domain.events(a).length, 1);
});

test("both participants trigger the daily companion bonus", () => {
  let clock = 1_700_000_000_000;
  const { domain, a, b } = pair(() => clock);
  domain.submit(a, { id: "event_user_a_01", type: "CARE", payload: { action: "feed" }, createdAt: clock });
  clock += 4000;
  const result = domain.submit(b, { id: "event_user_b_01", type: "CARE", payload: { action: "pet" }, createdAt: clock });
  assert.equal(result.state.growth, 12);
});

test("messages are validated and stay in the private event stream", () => {
  const { domain, a, b } = pair();
  domain.submit(a, { id: "message_event_01", type: "MESSAGE", payload: { text: "今晚早点休息呀" } });
  assert.equal(domain.events(b)[0].payload.text, "今晚早点休息呀");
  assert.throws(() => domain.submit(a, { id: "message_event_02", type: "MESSAGE", payload: { text: "x".repeat(101) } }));
});

test("offline event pages preserve oldest-first order without skipping", () => {
  const { domain, a, b } = pair();
  for (let index = 1; index <= 60; index += 1) {
    domain.submit(a, {
      id: `message_page_${String(index).padStart(3, "0")}`,
      type: "MESSAGE",
      payload: { text: `第 ${index} 条` }
    });
  }
  const firstPage = domain.events(b, 0);
  assert.equal(firstPage.length, 50);
  assert.deepEqual(firstPage.map((event) => event.seq), Array.from({ length: 50 }, (_, index) => index + 1));
  const secondPage = domain.events(b, firstPage.at(-1).seq);
  assert.equal(secondPage.length, 10);
  assert.deepEqual(secondPage.map((event) => event.seq), Array.from({ length: 10 }, (_, index) => index + 51));
});
