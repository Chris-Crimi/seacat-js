// Types for the SeaCat client. `const` type parameters need TypeScript 5.0 or later.

export declare const VERSION: string;

// --- Questions ---------------------------------------------------------------------------------------------

export interface CategoryQuestion<O extends string = string> {
  type: "category";
  text: string;
  options: Record<O, string> | readonly O[];
}

export interface ScaleQuestion<O extends string = string> {
  type: "scale";
  text: string;
  options: readonly O[];
}

export interface YesNoQuestion {
  type: "yes_no";
  text: string;
}

export type Question = CategoryQuestion | ScaleQuestion | YesNoQuestion;
export type Questions = Record<string, Question>;

/** Pick one of 2 to 26 options: `{ option: description }` or `[option, ...]`. */
export declare function category<const O extends string>(
  text: string,
  options: Record<O, string> | readonly O[],
): CategoryQuestion<O>;

/** Rate on 2 to 26 ordered levels, lowest first. */
export declare function scale<const O extends string>(text: string, levels: readonly O[]): ScaleQuestion<O>;

/** Is a statement true? */
export declare function yesNo(text: string): YesNoQuestion;

// --- Answers -----------------------------------------------------------------------------------------------

interface BaseAnswer<O extends string> {
  /** The most likely option. */
  answer: O;
  /** Each option's probability, in request order. They sum to 1 before rounding to 4 decimal places. */
  probabilities: Record<O, number>;
  /** `1 - entropy / ln(n)`: 1 when one option has all of it, 0 when it's split evenly. */
  certainty: number;
  /** The chosen option's probability. */
  probability: number;
  /** True when a yes_no question answered `yes`. */
  isYes: boolean;
  /** Whether `certainty` reaches `threshold` (0.9 by default). Tune the threshold on your own data. */
  confident(threshold?: number): boolean;
}

export interface CategoryAnswer<O extends string = string> extends BaseAnswer<O> {
  type: "category";
}

export interface ScaleAnswer<O extends string = string> extends BaseAnswer<O> {
  type: "scale";
  /** The expected level: the sum of each level's position (0 for the lowest) times its probability. */
  mean: number;
}

export interface YesNoAnswer extends BaseAnswer<"yes" | "no"> {
  type: "yes_no";
}

export type Answer = CategoryAnswer | ScaleAnswer | YesNoAnswer;

export type AnswerFor<Q> = Q extends CategoryQuestion<infer O>
  ? CategoryAnswer<O>
  : Q extends ScaleQuestion<infer O>
    ? ScaleAnswer<O>
    : Q extends YesNoQuestion
      ? YesNoAnswer
      : Answer;

export interface Usage {
  /** Billed input tokens: the system prompt and state once, plus each question's own tokens. */
  input_tokens: number;
  /** This request's cost in US dollars. 0 on a server without billing. */
  cost_usd: number;
}

export interface Decision<Q extends Questions = Questions> {
  /** The model that answered. */
  model: string;
  /** One answer per question, under the question's name. */
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  usage: Usage;
  /** `Server-Timing` as { name: milliseconds }: where the server spent the request, for debugging. */
  timing: Record<string, number>;
  /** The response exactly as the API sent it. */
  raw: unknown;
}

export interface Model {
  name: string;
  price_per_mtok_usd: number;
}

// --- Errors ------------------------------------------------------------------------------------------------

/** Base class for everything this client throws. */
export declare class SeaCatError extends Error {
  constructor(message: string, options?: ErrorOptions);
}

/** The API answered with an error. */
export declare class APIError extends SeaCatError {
  constructor(status: number, detail: string, retryAfter?: number);
  /** The HTTP status. */
  status: number;
  /** What the API said went wrong. */
  detail: string;
  /** Seconds to wait before retrying, from `Retry-After`. */
  retryAfter?: number;
}

/** 401: the API key is missing, invalid or revoked. */
export declare class AuthenticationError extends APIError {}
/** 402: the account is out of credits. */
export declare class OutOfCredits extends APIError {}
/** 403: the account is on the waitlist. */
export declare class AccessPending extends APIError {}
/** 400 or 422: the request needs fixing. Retrying it unchanged will fail again. */
export declare class InvalidRequest extends APIError {}
/** 404: no result with this ID for this key, or it is over an hour old. */
export declare class NotFound extends APIError {}
/** 429: over this key's requests per minute or requests in progress. Wait `retryAfter` seconds. */
export declare class RateLimited extends APIError {}
/** 503: the model couldn't be reached. Wait `retryAfter` seconds. */
export declare class ModelUnavailable extends APIError {}
/** An unexpected 5xx. */
export declare class ServerError extends APIError {}
/** The request never got an answer: DNS, connection or TLS failure. */
export declare class TransportError extends SeaCatError {}

/**
 * The call ran past `timeout`.
 *
 * A queued request keeps being worked on after this, and is charged once whether or not its answer is collected.
 * When `resultUrl` is set, pass it to `SeaCat#result()` later to collect the answer, for up to an hour.
 */
export declare class TimeoutError extends SeaCatError {
  constructor(message: string, resultUrl?: string);
  resultUrl?: string;
}

// --- Client ------------------------------------------------------------------------------------------------

export interface SeaCatOptions {
  /** Your API key. Defaults to `SEACAT_API_KEY`. */
  apiKey?: string;
  /** The server. Defaults to `SEACAT_BASE_URL`, then https://seacat.dev. */
  baseUrl?: string;
  /** Milliseconds for a whole call, redirects and retries included. 300,000 by default. */
  timeout?: number;
  /** How many times to retry a timeout, a network failure, a 429 or a 5xx. 2 by default. */
  retries?: number;
  /** An alternative fetch implementation. */
  fetch?: typeof fetch;
}

export interface DecideOptions {
  /** Omit it, or pass `latest` or a name from `models()`. */
  model?: string;
  /** Milliseconds for this call, overriding the client's `timeout`. */
  timeout?: number;
}

export declare class SeaCat {
  constructor(options?: SeaCatOptions);
  apiKey: string;
  baseUrl: string;
  timeout: number;
  retries: number;
  fetch: typeof fetch;

  /**
   * Answer every question about `state`. Each question is answered on its own, from the state and its own text,
   * and every answer is one of your options.
   */
  decide<const Q extends Questions>(
    state: string | object | unknown[],
    questions: Q,
    options?: DecideOptions,
  ): Promise<Decision<Q>>;

  /** Collect the answer to a call that ran past its timeout, using `TimeoutError.resultUrl`. */
  result(resultUrl: string, options?: { timeout?: number }): Promise<Decision>;

  /** The model this server runs and its price. No API key needed. */
  models(): Promise<Model[]>;
}
