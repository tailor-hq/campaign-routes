/**
 * The caching a rule source needs, once, so the two sources cannot disagree.
 *
 * Both `/contentful` and `/endpoint` want the same four behaviours, and each one
 * is load-bearing rather than an optimisation:
 *
 * - **A TTL**, so a page load does not wait on a network read it made a second
 *   ago.
 * - **One in-flight read at a time.** Without it, the moment a cache expires
 *   under load every concurrent request starts its own fetch — a thundering herd
 *   aimed at the customer's own rate-limited API, caused by us.
 * - **A deadline.** Failing open requires the promise to *settle*; a connection
 *   the server accepts and then stalls on never rejects, so a catch block never
 *   runs and Lambda@Edge kills the invocation before JavaScript regains control.
 * - **Last-good on failure.** Serving stale rules through an outage is the safer
 *   half of the trade: the alternative is a blip silently switching every
 *   campaign off.
 *
 * Written once because two copies of this drift, and the drift is invisible —
 * both still return rules, just not the same ones under load.
 *
 * Not exported from the package. It is how the sources are built, not something
 * a customer configures.
 */

export interface CachedLoaderConfig<T> {
  /** How long a loaded value is served without refreshing, in ms. */
  ttlMs: number;
  /** How long a single load may take before it is abandoned, in ms. */
  timeoutMs: number;
  /** Perform the read. The signal is aborted when the deadline passes. */
  load: (signal: AbortSignal) => Promise<T>;
  /**
   * A value to start from, so the first request of a new isolate is not
   * un-personalized.
   *
   * Bootstrapping is a well-worn pattern, for a reason that shows up in
   * production and never in testing: an edge runtime spawns isolates
   * constantly, and each one begins with an empty cache. Without a bootstrap the first visitor to hit
   * each new isolate gets the un-personalized page — a small, permanent,
   * invisible loss that scales with how bursty the traffic is, which on a
   * marketing site is exactly when it costs the most.
   *
   * It is treated as already stale, so a real read starts immediately and the
   * shipped copy is only ever what is served while that is in flight.
   */
  bootstrap?: T;
  /**
   * How long a last-good value may keep serving while refreshes fail, in ms.
   * Default one hour. Past it, reads answer with nothing and the caller falls
   * back to the page it was going to serve, so a campaign somebody withdrew
   * cannot outlive an outage by more than this. A shipped bootstrap is bound
   * the same way, counted from the moment the loader was built.
   */
  maxStaleMs?: number;
  /**
   * Told about every failed refresh, so the customer's own monitoring can
   * know the rules are going stale. Never awaited; a throw inside it is
   * swallowed, since a broken logger must not take the page down.
   */
  onError?: (error: unknown) => void;
  /**
   * The runtime's way of keeping work alive past the response. A background
   * refresh is a floating promise, and Cloudflare Workers and Vercel's edge
   * runtime may cancel outstanding work once the response is sent; handed to
   * `waitUntil`, it finishes. Without it nothing breaks — the next request
   * starts another refresh — but under low traffic the rules lag past the
   * TTL. A throw inside it is swallowed: a native `waitUntil` detached from
   * its receiver throws `Illegal invocation`, and that must not cost a page.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * Whether a stale read waits for its refresh instead of serving stale and
   * refreshing behind it. Default `false`. For a runtime that freezes the
   * execution environment the moment the handler returns (Lambda@Edge), where
   * a background refresh may never run at all: the cost is one request per
   * TTL per isolate paying the round trip, against unbounded staleness.
   */
  awaitStaleRefresh?: boolean;
}

export const DEFAULT_TTL_MS = 60_000;
export const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_MAX_STALE_MS = 60 * 60_000;

/**
 * A duration the caller configured, or the default when it is not one.
 *
 * `ttlMs: Number(process.env.CAMPAIGN_TTL_MS)` with the variable unset is
 * `NaN`, and `NaN` fails every comparison silently: a `NaN` TTL is never fresh
 * (one upstream read per page request), a `NaN` outage bound never expires
 * (withdrawn rules served forever), and `setTimeout(NaN)` fires at once (every
 * read aborted before it starts). Nothing would log any of it.
 */
export const duration = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

const DEFERRED = 'campaign-routes/deferred-read';

/**
 * What a `load` throws when it chose not to read this time — a concurrency cap
 * declining a burst, say. Not a failure: no backoff starts, `onError` is not
 * told, and the next read tries again. A marker rather than an `Error`
 * subclass, because `instanceof` on a subclassed `Error` does not survive the
 * ES5 downlevel this package builds with.
 */
export const deferredRead = (): Error => Object.assign(new Error('rule read deferred'), { kind: DEFERRED });

const isDeferredRead = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { kind?: unknown }).kind === DEFERRED;

export interface CachedLoader<T> {
  /**
   * The current value, or null when nothing has ever loaded successfully.
   *
   * Never throws and never rejects. A caller decides what null means for it —
   * for every caller here it means "serve the page you were going to serve".
   */
  read: () => Promise<T | null>;
  /**
   * The last value loaded, without touching the network.
   *
   * For the synchronous questions an adapter has to answer mid-request, where
   * awaiting a refresh is not available.
   */
  peek: () => T | null;
}

/**
 * How long to leave a failing upstream alone, doubling per consecutive failure.
 *
 * A failed read deliberately leaves `cachedAt` alone so the next visitor
 * retries rather than waiting out a whole TTL on a blip — and on its own that
 * rule turns a fast failure into a storm. Contentful answering 429 in five
 * milliseconds means the in-flight collapse protects almost nothing, and every
 * page request becomes an upstream request against a service that is already
 * refusing, for as long as the outage lasts. So a failure also starts a wait
 * that grows with each one in a row, during which reads are answered from
 * whatever is cached (or with nothing) and the upstream is not touched.
 */
const FAILURE_BACKOFF_BASE_MS = 1_000;
const FAILURE_BACKOFF_MAX_MS = 30_000;

export const createCachedLoader = <T>(config: CachedLoaderConfig<T>): CachedLoader<T> => {
  // A bootstrap starts life already expired (`cachedAt` 0), so the first read
  // returns it AND kicks off a real one behind it. Shipped rules are a floor,
  // never a thing that delays the truth.
  let cached: T | null = config.bootstrap ?? null;
  let cachedAt = 0;
  // When the value in hand was installed, for the outage bound. A bootstrap's
  // `cachedAt` stays 0 so a real read starts at once, but it was installed now.
  let installedAt = cached !== null ? Date.now() : 0;
  let inFlight: Promise<T | null> | null = null;
  let consecutiveFailures = 0;
  let lastFailureAt = 0;
  const ttlMs = duration(config.ttlMs, DEFAULT_TTL_MS);
  // A zero deadline aborts every read before it starts, and `Number('')` is 0,
  // so a variable that is set but empty must fall back like an absent one.
  const timeoutMs = duration(config.timeoutMs, DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  // Never shorter than the TTL: below it `read` (which checks freshness first)
  // and `peek` (which checks the bound first) would disagree, and `pageExists`
  // would answer "unknown" for rules `getRoutes` was still serving.
  const maxStaleMs = Math.max(ttlMs, duration(config.maxStaleMs, DEFAULT_MAX_STALE_MS));

  const backoffMs = (): number =>
    Math.min(FAILURE_BACKOFF_MAX_MS, FAILURE_BACKOFF_BASE_MS * 2 ** Math.min(consecutiveFailures - 1, 10));
  const backingOff = (): boolean =>
    consecutiveFailures > 0 && Date.now() - lastFailureAt < backoffMs();
  const tooStale = (): boolean =>
    cached !== null && installedAt > 0 && Date.now() - installedAt > maxStaleMs;

  const report = (error: unknown): void => {
    if (!config.onError) return;
    try {
      config.onError(error);
    } catch {
      // A customer's error hook must not take the page down.
    }
  };

  /** Hand a background refresh to the runtime, where there is a runtime to hand it to. */
  const keep = (running: Promise<T | null>): void => {
    if (!config.waitUntil) return;
    try {
      config.waitUntil(running);
    } catch {
      // A detached native `waitUntil` throws; the refresh still runs as a
      // floating promise, which is what it would have been anyway.
    }
  };

  const run = async (): Promise<T | null> => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const value = await config.load(controller.signal);
      cached = value;
      cachedAt = Date.now();
      installedAt = cachedAt;
      consecutiveFailures = 0;
      return value;
    } finally {
      // In `finally` so a timer never outlives the read that armed it. On a fast
      // response an uncleared timer holds the Node event loop open, which in a
      // Lambda shows up as an invocation that will not end.
      clearTimeout(deadline);
    }
  };

  const refresh = (): Promise<T | null> => {
    if (inFlight) return inFlight;
    inFlight = run()
      // A failed read does NOT update `cachedAt`, so the next caller retries
      // rather than waiting out a TTL on an error — after the backoff above.
      .catch((error: unknown) => {
        if (isDeferredRead(error)) return tooStale() ? null : cached;
        consecutiveFailures += 1;
        lastFailureAt = Date.now();
        report(error);
        return tooStale() ? null : cached;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    peek: () => (tooStale() ? null : cached),
    read: async () => {
      const fresh = cached !== null && Date.now() - cachedAt < ttlMs;
      if (fresh) return cached;

      // An outage has outlived the bound: keep trying behind the request, but
      // answer with nothing so the caller serves the page it was going to.
      if (tooStale()) {
        if (backingOff()) return null;
        const running = refresh();
        if (config.awaitStaleRefresh === true) return running;
        keep(running);
        return null;
      }

      // Inside a failure backoff the upstream is left alone: whatever is in
      // hand is the answer, and nothing being in hand is the answer too.
      if (backingOff()) return cached;

      // **Stale-while-revalidate.** With a value in hand, serve it and refresh
      // behind the request rather than making somebody wait. Blocking here is
      // what every rule source did before, and it means one unlucky visitor per
      // TTL per isolate pays the full network round trip for a value the next
      // visitor gets for free — a latency spike that is invisible in testing,
      // where nothing has expired yet, and permanent in production.
      //
      // The trade is bounded and worth naming: a just-published campaign can
      // take up to twice the TTL to appear, because the request that notices
      // the lapse is still served the old rules.
      if (cached !== null) {
        // Deliberately not awaited, unless the runtime cannot be trusted to run
        // it later. The `.catch` inside `refresh` is what keeps an unobserved
        // rejection from becoming an unhandled one.
        const running = refresh();
        if (config.awaitStaleRefresh === true) return running;
        keep(running);
        return cached;
      }

      // Nothing to serve, so this one has to wait.
      return refresh();
    }
  };
};
