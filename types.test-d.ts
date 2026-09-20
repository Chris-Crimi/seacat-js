// Type tests for index.d.ts, checked by `npm run typecheck`. Nothing here runs.
import { SeaCat, category, scale, yesNo, APIError, RateLimited, TimeoutError, type Decision } from "./index.js";

const sc = new SeaCat({ apiKey: "tz_x", timeout: 30_000 });

const questions = {
  stage: category("How far along?", { researching: "Early", evaluating: "Comparing", ready: "Approved" }),
  fit: scale("How well does it match?", ["Poor", "Partial", "Strong"]),
  spam: yesNo("Is this spam?"),
};

async function main() {
  const d = await sc.decide("A lead wrote in.", questions);

  // Each answer is typed by its question's type, and options come through as literals.
  const stage: "researching" | "evaluating" | "ready" = d.answers.stage.answer;
  const fit: "Poor" | "Partial" | "Strong" = d.answers.fit.answer;
  const mean: number = d.answers.fit.mean;
  const isYes: boolean = d.answers.spam.isYes;
  const p: number = d.answers.stage.probabilities.ready;
  const sure: boolean = d.answers.stage.confident(0.8);
  const tokens: number = d.usage.input_tokens;
  void [stage, fit, mean, isYes, p, sure, tokens];

  // @ts-expect-error a yes_no answer has no mean
  d.answers.spam.mean;
  // @ts-expect-error not one of this question's options
  const wrong: "ready" = d.answers.fit.answer;
  void wrong;
  // @ts-expect-error no question by that name
  d.answers.nothing;
  // @ts-expect-error probabilities are keyed by option
  d.answers.stage.probabilities.nope;

  // An object state, a pinned model, and a hand-written question.
  await sc.decide({ amount: 42 }, { ok: { type: "yes_no", text: "Approved?" } }, { model: "latest" });

  // @ts-expect-error a scale needs its levels
  scale("How well?");
  // @ts-expect-error a question needs one of the three types
  await sc.decide("hi", { q: { type: "maybe", text: "?" } });

  const loose: Decision = d; // a Decision with unknown questions still assigns
  void loose;

  const models = await sc.models();
  const price: number = models[0].price_per_mtok_usd;
  void price;

  try {
    await sc.decide("hi", questions);
  } catch (err) {
    if (err instanceof RateLimited) {
      const wait: number | undefined = err.retryAfter;
      void wait;
    } else if (err instanceof TimeoutError) {
      const url: string | undefined = err.resultUrl;
      if (url) await sc.result(url);
    } else if (err instanceof APIError) {
      const status: number = err.status;
      void [status, err.detail];
    }
  }
}

void main;
