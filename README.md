# SeaCat for TypeScript

A client for the [SeaCat](https://seacat.dev) API: you send some state and a set of typed questions, and you get
back structured answers with probabilities and a certainty score your code can branch on. No dependencies — it
uses the runtime's `fetch` (Node 18+, Bun, Deno, Cloudflare Workers).

```bash
npm install seacat-ai
```

```ts
import { SeaCat, category, scale, yesNo } from "seacat-ai";

const sc = new SeaCat(); // or new SeaCat({ apiKey: "tz_..." }) — the default reads SEACAT_API_KEY

const { answers } = await sc.decide(
  "Hi, I run operations at a 40-person logistics company. Budget is approved and we need " +
    "something live before our peak season in November. Could you walk me through pricing for 25 seats?",
  {
    stage: category("How far along is this lead in buying?", {
      researching: "Early research, no timeline or budget yet",
      evaluating: "Comparing options, with a rough timeline",
      ready: "Budget approved and a firm deadline",
    }),
    fit: scale("How well does this company match our target customer: logistics or retail, 20 to 500 people?", [
      "Poor match",
      "Partial match",
      "Strong match",
    ]),
    wantsPricing: yesNo("Does the message ask about prices or plans?"),
  },
);

if (answers.stage.answer === "ready" && answers.fit.mean > 1.5) routeToSales();
```

TypeScript reads the question types through: `answers.stage.answer` is `"researching" | "evaluating" | "ready"`,
`answers.fit.mean` is a number, `answers.wantsPricing.isYes` is a boolean, and a name you never asked about is a
compile error. The types need TypeScript 5.0 or later; plain JavaScript works the same without them.

## Questions

`category(text, options)` picks one of 2 to 26 options, given as `{ option: description }` or `[option, ...]`.
`scale(text, levels)` rates on 2 to 26 ordered levels, lowest first. `yesNo(text)` asks whether a statement is
true. Each builder returns a plain object, so a hand-written one works just as well:

```ts
await sc.decide(state, { isSpam: { type: "yes_no", text: "Is this comment spam?" } });
```

The state can be a string, or an object or array, which is sent as JSON. It is read once per request and shared by
every question, so asking ten questions about one state costs far less than ten requests.

Each question sees only the state and its own text — not your other questions, and not their answers. Define any
term it can't guess, and precompute totals and counts into the state rather than asking for arithmetic.

## Answers

`decide()` resolves to a `Decision`: `answers` keyed by question name, plus `model` and `usage`.

```ts
answers.stage.answer          // 'ready' — always one of your options
answers.stage.probabilities   // { researching: 0.02, evaluating: 0.07, ready: 0.91 }
answers.stage.probability     // 0.91 — the chosen option's probability
answers.stage.certainty       // 0.77 — 1 when one option has all of it, 0 when it's split evenly
answers.stage.confident(0.8)  // false
answers.fit.mean              // 1.75 — scale questions only: the expected level, where 0 is the lowest
answers.wantsPricing.isYes    // true

const { model, usage, timing, raw } = await sc.decide(state, questions);
// timing: Server-Timing as { name: ms } — where the server spent the request. Empty for an answer
//   collected from the queue, which the API doesn't time.
// raw: the response exactly as the API sent it
```

Certainty is a measure of how spread the probabilities are, not a promise of being right. Tune your thresholds on
your own data.

## Errors

Everything thrown inherits from `SeaCatError`. An error from the API is an `APIError` with `status`, `detail` and,
where the API sent one, `retryAfter`:

| Class | Status | |
|---|---|---|
| `InvalidRequest` | 400, 422 | The request needs fixing: too long for the model's input limit, an unknown `model`, or a malformed question. Retrying it unchanged will fail again. |
| `AuthenticationError` | 401 | The key is missing, invalid or revoked. |
| `OutOfCredits` | 402 | Add credits on the dashboard. |
| `AccessPending` | 403 | The account is on the waitlist. |
| `NotFound` | 404 | No result with this ID for this key, or it is over an hour old. |
| `RateLimited` | 429 | Over this key's requests per minute, or requests in progress. |
| `ModelUnavailable` | 503 | The model couldn't be reached. |
| `ServerError` | 5xx | Unexpected. |
| `TransportError` | — | The request never got an answer: DNS, connection or TLS. |
| `TimeoutError` | — | No answer within `timeout`. |

A timeout, a network failure, a `429` and a `5xx` are retried on their own (`retries: 2` by default), waiting as
long as `Retry-After` says. The rest are thrown straight away, because retrying them unchanged would fail again.

## Cold starts and slow requests

The GPU scales to zero, so the first request after an idle spell waits a minute or two for it to start. The API
answers a slow request with a redirect to a result URL, and the client follows it for you.

`timeout` (300,000 ms by default) covers the whole call, redirects and retries included. When it runs out, the
`TimeoutError` carries the result URL, and the answer can still be collected for up to an hour, with the same key:

```ts
try {
  await sc.decide(state, questions, { timeout: 30_000 });
} catch (err) {
  if (!(err instanceof TimeoutError)) throw err;
  await save(err.resultUrl); // ... later, in a worker:
  const d = await sc.result(err.resultUrl);
}
```

A queued request is charged once when it finishes, whether or not its answer is collected.

## Configuration

```ts
new SeaCat({
  apiKey,          // defaults to SEACAT_API_KEY
  baseUrl,         // defaults to SEACAT_BASE_URL, then https://seacat.dev
  timeout: 300_000, // milliseconds for a whole call, redirects and retries included
  retries: 2,      // retries for a timeout, a network failure, a 429 or a 5xx
  fetch,           // an alternative fetch implementation
});
```

`sc.models()` returns the model this server runs and its price. It needs no key.

One client can be shared across concurrent requests: it holds no per-request state.

The package is ESM. Node 22.12 and later can `require()` it from CommonJS; a separate CommonJS build isn't there
yet.

## Tests

`npm test` (`node --test`), against a local HTTP server that answers the way the API does, including the
queued-result path. It needs no dependencies. `npm install && npm run typecheck` checks `index.d.ts` against the
type tests in `types.test-d.ts`, which is the only thing TypeScript is needed for.

## License

MIT — see [LICENSE](https://github.com/Chris-Crimi/seacat-js/blob/main/LICENSE). The client is MIT so you can install, read and modify it freely. The SeaCat
service it calls is a separate, proprietary product, governed by the [Terms](https://seacat.dev/terms).
