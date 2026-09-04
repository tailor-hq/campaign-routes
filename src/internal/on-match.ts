/**
 * Telling the host application that a campaign served.
 *
 * # Why a callback and not telemetry
 *
 * This package phones nothing home, and that stays true — a personalization
 * layer that reports to its vendor on every page load is one a security team
 * will reject, correctly. But "we send nothing" had a second, unintended
 * consequence: **nobody else could tell either.** The page was personalized and
 * your own analytics had no idea, so a conversion could not be segmented by
 * whether a campaign page served it. A host-supplied callback is the usual
 * answer, and the shape is right: your function, your data, your destination.
 *
 * # It can never break a page load
 *
 * The callback is code we do not control, running on the request path of every
 * campaign click, in a runtime where an uncaught throw is a 5xx rather than a
 * logged error. So it is called inside a `try/catch`, and its return value is
 * ignored rather than awaited — an analytics call that hangs must not hold the
 * page, and one that throws must not lose it. The visitor still gets their
 * campaign page either way.
 *
 * That is the same failing-open promise the rest of the package makes, extended
 * to the one place the customer can inject arbitrary code into it.
 */

import type { CampaignRoute } from '../core/index.js';

/** What served, and why. Enough to attribute a conversion without guessing. */
export interface CampaignMatchEvent {
  /** The path the visitor asked for. */
  requestedPath: string;
  /** The path actually rendered. */
  targetPath: string;
  /** The campaign parameters the winning rule matched on. */
  matchParams: Record<string, string>;
  /** The whole rule, for a caller that wants more than the summary. */
  route: CampaignRoute;
}

export type OnCampaignMatch = (event: CampaignMatchEvent) => void;

/**
 * Fire the callback, swallowing anything it does.
 *
 * Not exported from the package: adapters call it, customers pass `onMatch`.
 */
export const notifyMatch = (
  onMatch: OnCampaignMatch | undefined,
  event: CampaignMatchEvent
): void => {
  if (typeof onMatch !== 'function') return;
  try {
    const result = onMatch(event) as unknown;

    // **A `try/catch` alone does not cover an async callback**, and this is the
    // case that matters most: `onMatch` is typed as returning void, but nothing
    // stops a customer writing `async (e) => fetch(...)`, which is the obvious
    // way to send an analytics beacon. The returned promise is then dropped —
    // and an unhandled rejection is not a warning in a Lambda, it terminates
    // the process. Attaching a no-op catch observes it without waiting for it,
    // which is what keeps this both non-blocking and non-fatal.
    if (result && typeof (result as PromiseLike<void>).then === 'function') {
      void (result as PromiseLike<void>).then(undefined, () => {});
    }
  } catch {
    // Their analytics is not worth their page. Nothing is logged, because there
    // is nowhere this package is willing to log to.
  }
};
