/**
 * SeaCat API client. Typed decisions over HTTP, with no dependencies: it uses the runtime's `fetch`
 * (Node 18+, Bun, Deno, Cloudflare Workers).
 *
 *   import { SeaCat, category, scale, yesNo } from "seacat-ai";
 *
 *   const sc = new SeaCat(); // reads SEACAT_API_KEY
 *   const d = await sc.decide("Budget is approved and we need this live before November.", {
 *     stage: category("How far along is this lead in buying?", { researching: "No timeline yet", ready: "Budget approved" }),
 *     fit: scale("How well does this match our target customer?", ["Poor", "Partial", "Strong"]),
 *     wantsPricing: yesNo("Does the message ask about prices or plans?"),
 *   });
 *   d.answers.stage.answer;      // 'ready'
 *   d.answers.stage.probability; // 0.91
 *   d.answers.fit.mean;          // 1.8
 *   d.answers.wantsPricing.isYes // true
 */

export const VERSION = "0.1.0";

const DEFAULT_BASE_URL = "https://seacat.dev";
// A queued request is redirected to a result URL that waits about a minute per hop, so one HTTP request should
// never need more than this, and the whole call is bounded by `timeout` instead.
const MAX_REQUEST_MS = 120_000;

// --- Questions ---------------------------------------------------------------------------------------------
// Small builders: a question is a plain object, so a hand-written one works just as well.

/** Pick one of 2 to 26 options: `{ option: description }` or `[option, ...]`. */
export function category(text, options) {
  return { type: "category", text, options };
}

/** Rate on 2 to 26 ordered levels, lowest first. */
export function scale(text, levels) {
  return { type: "scale", text, options: levels };
}

/** Is a statement true? */
export function yesNo(text) {
  return { type: "yes_no", text };
}

// --- Errors ------------------------------------------------------------------------------------------------

/** Base class for everything this client throws. */
export class SeaCatError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The API answered with an error. `status` is the HTTP status and `detail` what the API said. */
export class APIError extends SeaCatError {
  constructor(status, detail, retryAfter) {
    super(`${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
    this.retryAfter = retryAfter;
  }
}

/** 401: the API key is missing, invalid or revoked. */
export class AuthenticationError extends APIError {}
/** 402: the account is out of credits. */
export class OutOfCredits extends APIError {}
/** 403: the account is on the waitlist. */
export class AccessPending extends APIError {}
/** 400 or 422: the request needs fixing. Retrying it unchanged will fail again. */
export class InvalidRequest extends APIError {}
/** 404: no result with this ID for this key, or it is over an hour old. */
export class NotFound extends APIError {}
/** 429: over this key's requests per minute or requests in progress. Wait `retryAfter` seconds. */
export class RateLimited extends APIError {}
/** 503: the model couldn't be reached. Wait `retryAfter` seconds. */
export class ModelUnavailable extends APIError {}
/** An unexpected 5xx. */
export class ServerError extends APIError {}

/** The request never got an answer: DNS, connection or TLS failure. */
export class TransportError extends SeaCatError {}

/**
 * The call ran past `timeout`.
 *
 * A queued request keeps being worked on after this, and is charged once whether or not its answer is collected.
 * When `resultUrl` is set, pass it to `SeaCat#result()` later to collect the answer, for up to an hour.
 */
export class TimeoutError extends SeaCatError {
  constructor(message, resultUrl) {
    super(message);
    this.resultUrl = resultUrl;
  }
}

const BY_STATUS = {
  400: InvalidRequest,
  401: AuthenticationError,
  402: OutOfCredits,
  403: AccessPending,
  404: NotFound,
  422: InvalidRequest,
  429: RateLimited,
  503: ModelUnavailable,
};

// --- Client ------------------------------------------------------------------------------------------------

export class SeaCat {
  /**
   * apiKey: your key. Defaults to `SEACAT_API_KEY`.
   * baseUrl: the server. Defaults to `SEACAT_BASE_URL`, then https://seacat.dev.
   * timeout: milliseconds for a whole call, redirects and retries included. The GPU scales to zero, so the
   *   first request after an idle spell waits a minute or two for it to start.
   * retries: how many times to retry a timeout, a network failure, a 429 or a 5xx. `Retry-After` is honoured.
   * fetch: an alternative fetch implementation.
   */
  constructor({ apiKey, baseUrl, timeout = 300_000, retries = 2, fetch: fetchImpl } = {}) {
    const env = globalThis.process?.env ?? {};
    this.apiKey = apiKey ?? env.SEACAT_API_KEY ?? "";
    this.baseUrl = (baseUrl ?? env.SEACAT_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = timeout;
    this.retries = retries;
    this.fetch = fetchImpl ?? globalThis.fetch;
  }

  /**
   * Answer every question about `state`. Each question is answered on its own, from the state and its own text,
   * and every answer is one of your options.
   *
   * Throws an `APIError` subclass for an error from the API, `TransportError` if it couldn't be reached, and
   * `TimeoutError` if the answer didn't arrive within `timeout`.
   */
  async decide(state, questions, { model, timeout } = {}) {
    const body = { state, questions };
    if (model !== undefined) body.model = model;
    const deadline = Date.now() + (timeout ?? this.timeout);
    const res = await this.#request("POST", "/v1/decide", body, deadline);
    const done = res.status === 303 ? await this.#collect(res.location, deadline) : res;
    return decision(done.data, done.timing);
  }

  /**
   * Collect the answer to a call that ran past its timeout, using `TimeoutError.resultUrl`.
   *
   * Only the key that made the request can collect it, for up to an hour, and the request is charged once
   * however many times its result is fetched.
   */
  async result(resultUrl, { timeout } = {}) {
    const { data, timing } = await this.#collect(resultUrl, Date.now() + (timeout ?? this.timeout));
    return decision(data, timing);
  }

  /** The model this server runs and its price. No API key needed. */
  async models() {
    const { data } = await this.#request("GET", "/v1/models", null, Date.now() + this.timeout);
    return data.models;
  }

  // A queued request is redirected to a result URL, which waits about a minute and then redirects to itself
  // until the answer is ready.
  async #collect(url, deadline) {
    for (;;) {
      const res = await this.#request("GET", url, null, deadline, url);
      if (res.status !== 303) return res;
      url = res.location;
    }
  }

  async #request(method, path, body, deadline, resultUrl) {
    const url = /^https?:/.test(path) ? path : this.baseUrl + path;
    const headers = { Accept: "application/json", "User-Agent": `seacat-js/${VERSION}` };
    if (body !== null) headers["Content-Type"] = "application/json";
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const init = {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      redirect: "manual", // the result URL redirects to itself while it waits, so we follow it ourselves
    };

    for (let attempt = 0; ; attempt++) {
      const left = deadline - Date.now();
      if (left <= 0) throw new TimeoutError(`No answer within the timeout while calling ${method} ${url}.`, resultUrl);
      let status, error;
      try {
        // The body is read in here too: the signal can cut it off just as it can cut off the response.
        const res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(Math.min(left, MAX_REQUEST_MS)) });
        if (res.status === 303) {
          const location = res.headers.get("location");
          // A browser hides a manual redirect's Location. Server runtimes, where an API key belongs, don't.
          if (!location) throw new SeaCatError("The request was queued, but this runtime hides the redirect to it.");
          return { status: 303, location: new URL(location, url).toString() };
        }
        if (res.ok) return { status: res.status, data: await res.json(), timing: timing(res.headers) };
        [status, error] = [res.status, await apiError(res)];
      } catch (err) {
        if (err instanceof SeaCatError) throw err;
        if (attempt === this.retries) {
          if (err?.name === "TimeoutError" || err?.name === "AbortError") {
            throw new TimeoutError(`No answer within the timeout while calling ${method} ${url}.`, resultUrl);
          }
          throw new TransportError(`Could not reach ${url}: ${err?.message ?? err}`, { cause: err });
        }
      }
      if (error && (attempt === this.retries || !retriable(status))) throw error;
      await sleep(Math.min(backoff(attempt, error?.retryAfter), Math.max(0, deadline - Date.now())));
    }
  }
}

// --- Answers -----------------------------------------------------------------------------------------------

function decision(data, timing) {
  const answers = {};
  for (const [name, a] of Object.entries(data.answers)) answers[name] = answer(a);
  return { model: data.model, answers, usage: data.usage, timing, raw: data };
}

function answer(a) {
  return {
    ...a,
    /** The chosen option's probability. */
    probability: a.probabilities[a.answer],
    /** True when a yes_no question answered `yes`. */
    isYes: a.answer === "yes",
    /** Whether `certainty` reaches `threshold`. Tune the threshold on your own data. */
    confident(threshold = 0.9) {
      return a.certainty >= threshold;
    },
  };
}

// --- Plumbing ----------------------------------------------------------------------------------------------

/** `Server-Timing` as { name: milliseconds }: where the server spent the request, for debugging. */
function timing(headers) {
  const parsed = {};
  for (const part of (headers.get("server-timing") ?? "").split(",")) {
    const [name, dur] = part.trim().split(";dur=");
    if (dur !== undefined && !Number.isNaN(Number(dur))) parsed[name] = Number(dur);
  }
  return parsed;
}

function retriable(status) {
  return status === 429 || status >= 500;
}

function backoff(attempt, retryAfter) {
  if (retryAfter != null) return retryAfter * 1000;
  return Math.min(2 ** attempt, 8) * (500 + Math.random() * 1000); // jitter, so retries don't line up
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiError(res) {
  const header = res.headers.get("retry-after");
  const retryAfter = header && !Number.isNaN(Number(header)) ? Number(header) : undefined;
  const Error_ = BY_STATUS[res.status] ?? ServerError;
  return new Error_(res.status, await detail(res), retryAfter);
}

async function detail(res) {
  let body;
  try {
    body = (await res.json()).detail;
  } catch {
    return res.statusText || "request failed";
  }
  if (Array.isArray(body)) {
    // a 422 lists the fields that failed validation
    return body.map((d) => `${(d.loc ?? []).join(".")}: ${d.msg ?? ""}`).join("; ");
  }
  return String(body ?? "") || res.statusText || "request failed";
}
