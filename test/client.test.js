// Tests the client against a real HTTP server that answers like the API does.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import {
  APIError,
  AuthenticationError,
  InvalidRequest,
  OutOfCredits,
  RateLimited,
  SeaCat,
  TimeoutError,
  category,
  scale,
  yesNo,
} from "../index.js";

const ANSWERS = {
  stage: {
    type: "category",
    answer: "ready",
    probabilities: { researching: 0.02, evaluating: 0.07, ready: 0.91 },
    certainty: 0.77,
  },
  fit: {
    type: "scale",
    answer: "Strong",
    probabilities: { Poor: 0.05, Partial: 0.15, Strong: 0.8 },
    certainty: 0.5,
    mean: 1.75,
  },
  spam: { type: "yes_no", answer: "no", probabilities: { yes: 0.1, no: 0.9 }, certainty: 0.53 },
};
const BODY = { model: "seacat-1", answers: ANSWERS, usage: { input_tokens: 1000, cost_usd: 0.0002 } };

let server, baseUrl;
const requests = []; // every request the server saw
let plan = []; // queued responses for /v1/decide, oldest first

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.url === "/v1/models") return json(res, 200, { models: [{ name: "seacat-1", price_per_mtok_usd: 0.2 }] });
      const next = plan.shift() ?? { status: 200, body: BODY };
      if (next.status === 303) {
        res.writeHead(303, { location: next.location, "content-type": "application/json" });
        return res.end(JSON.stringify({ status: "queued", result_url: next.location }));
      }
      if (next.delayMs) return setTimeout(() => json(res, next.status, next.body, next.headers), next.delayMs);
      json(res, next.status, next.body, next.headers ?? { "server-timing": "auth;dur=0.1, model;dur=137.0" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function client(options = {}) {
  requests.length = 0;
  plan = [];
  return new SeaCat({ apiKey: "sk-test", baseUrl, retries: 0, ...options });
}

describe("decide", () => {
  it("sends the key and the questions, and reads the answers", async () => {
    const sc = client();
    const d = await sc.decide("A lead wrote in.", {
      stage: category("How far along?", { researching: "Early", evaluating: "Comparing", ready: "Approved" }),
      fit: scale("How well does it match?", ["Poor", "Partial", "Strong"]),
      spam: yesNo("Is this spam?"),
    });

    const sent = JSON.parse(requests[0].body);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/v1/decide");
    assert.equal(requests[0].auth, "Bearer sk-test");
    assert.equal(sent.state, "A lead wrote in.");
    assert.deepEqual(sent.questions.fit, { type: "scale", text: "How well does it match?", options: ["Poor", "Partial", "Strong"] });
    assert.deepEqual(sent.questions.spam, { type: "yes_no", text: "Is this spam?" });
    assert.ok(!("model" in sent));

    assert.equal(d.model, "seacat-1");
    assert.equal(d.answers.stage.answer, "ready");
    assert.equal(d.answers.stage.probability, 0.91);
    assert.equal(d.answers.fit.mean, 1.75);
    assert.equal(d.answers.spam.isYes, false);
    assert.equal(d.answers.stage.confident(0.7), true);
    assert.equal(d.answers.stage.confident(), false);
    assert.equal(d.usage.input_tokens, 1000);
    assert.deepEqual(d.timing, { auth: 0.1, model: 137 }); // Server-Timing, for debugging
    assert.deepEqual(d.raw, BODY);
  });

  it("passes model when given", async () => {
    const sc = client();
    await sc.decide("hi", { spam: yesNo("Is this spam?") }, { model: "latest" });
    assert.equal(JSON.parse(requests[0].body).model, "latest");
  });

  it("follows the redirect a queued request gets, and keeps the key on it", async () => {
    const sc = client();
    plan = [
      { status: 303, location: "/v1/decide/result/fc-1" },
      { status: 303, location: "/v1/decide/result/fc-1" }, // the result URL redirects to itself while it waits
      { status: 200, body: BODY },
    ];
    const d = await sc.decide("hi", { spam: yesNo("Is this spam?") });
    assert.equal(d.answers.spam.answer, "no");
    assert.deepEqual(
      requests.map((r) => `${r.method} ${r.url}`),
      ["POST /v1/decide", "GET /v1/decide/result/fc-1", "GET /v1/decide/result/fc-1"],
    );
    assert.ok(requests.every((r) => r.auth === "Bearer sk-test"));
  });

  it("collects a queued result later", async () => {
    const sc = client();
    const d = await sc.result("/v1/decide/result/fc-2");
    assert.equal(requests[0].url, "/v1/decide/result/fc-2");
    assert.equal(d.answers.stage.answer, "ready");
  });
});

describe("errors", () => {
  const cases = [
    [401, "Invalid or missing API key.", AuthenticationError],
    [402, "Out of credits.", OutOfCredits],
    [400, "State plus question is 40213 tokens.", InvalidRequest],
  ];
  for (const [status, detail, Expected] of cases) {
    it(`raises ${Expected.name} on ${status}`, async () => {
      const sc = client();
      plan = [{ status, body: { detail } }];
      const err = await sc.decide("hi", { spam: yesNo("?") }).then(
        () => null,
        (e) => e,
      );
      assert.ok(err instanceof Expected, `${err}`);
      assert.ok(err instanceof APIError);
      assert.equal(err.status, status);
      assert.equal(err.detail, detail);
      assert.equal(requests.length, 1); // not retried
    });
  }

  it("reads a 422's field errors", async () => {
    const sc = client();
    plan = [{ status: 422, body: { detail: [{ loc: ["body", "questions", "spam", "type"], msg: "unexpected value" }] } }];
    await assert.rejects(sc.decide("hi", { spam: yesNo("?") }), {
      name: "InvalidRequest",
      detail: "body.questions.spam.type: unexpected value",
    });
  });

  it("retries a 429 after Retry-After, then succeeds", async () => {
    const sc = client({ retries: 2 });
    plan = [
      { status: 429, body: { detail: "Too many requests." }, headers: { "retry-after": "0" } },
      { status: 200, body: BODY },
    ];
    const started = Date.now();
    const d = await sc.decide("hi", { spam: yesNo("?") });
    assert.equal(d.answers.spam.answer, "no");
    assert.equal(requests.length, 2);
    assert.ok(Date.now() - started < 1000);
  });

  it("gives up after the last retry", async () => {
    const sc = client({ retries: 1 });
    plan = [
      { status: 429, body: { detail: "Too many requests." }, headers: { "retry-after": "0" } },
      { status: 429, body: { detail: "Too many requests." }, headers: { "retry-after": "0" } },
    ];
    const err = await sc.decide("hi", { spam: yesNo("?") }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof RateLimited);
    assert.equal(err.retryAfter, 0);
    assert.equal(requests.length, 2);
  });

  it("retries a 500", async () => {
    const sc = client({ retries: 1 });
    plan = [{ status: 500, body: { detail: "boom" } }, { status: 200, body: BODY }];
    await sc.decide("hi", { spam: yesNo("?") });
    assert.equal(requests.length, 2);
  });

  it("times out and reports where the answer can be collected", async () => {
    const sc = client({ timeout: 300 });
    plan = [
      { status: 303, location: "/v1/decide/result/fc-3" },
      { status: 200, body: BODY, delayMs: 2000 },
    ];
    const err = await sc.decide("hi", { spam: yesNo("?") }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof TimeoutError, `${err}`);
    assert.match(err.resultUrl, /\/v1\/decide\/result\/fc-3$/);
  });

  it("raises TransportError when the server can't be reached", async () => {
    const sc = new SeaCat({ apiKey: "k", baseUrl: "http://127.0.0.1:1", retries: 0 });
    await assert.rejects(sc.decide("hi", { spam: yesNo("?") }), { name: "TransportError" });
  });
});

describe("models", () => {
  it("needs no key", async () => {
    const sc = new SeaCat({ baseUrl, retries: 0 });
    requests.length = 0;
    assert.deepEqual(await sc.models(), [{ name: "seacat-1", price_per_mtok_usd: 0.2 }]);
    assert.equal(requests[0].auth, undefined);
  });
});
