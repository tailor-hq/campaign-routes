/**
 * Deciding which campaign page a request should be served, and nothing else.
 *
 * A Tailor test that ran only for `utm_term=enterprise plan` wins. Its
 * copy is true about that campaign's traffic and unproven for everyone else, so
 * the page it ran on must not change — Tailor writes a copy of the page instead,
 * plus a rule saying which traffic it is for. This function reads those rules.
 *
 * # It takes the rules; it never fetches them
 *
 * That is the whole design, and it is not a stylistic choice. The integration
 * point differs per customer and the deciding factor is whether it can make a
 * network call:
 *
 * - A Next.js middleware or a Cloudflare Worker can fetch the rules itself.
 * - **A CloudFront Function cannot make network calls at all.** On a statically
 *   exported site served from object storage, that is the only place to
 *   intercept a request at all, and the rules have to arrive from a
 *   KeyValueStore, read in-process.
 *
 * A function that fetched its own rules would work on some of those and be
 * unusable on others. Taking them as an argument makes one tested implementation
 * serve every stack.
 *
 * # ES 5.1 built-ins only, deliberately
 *
 * CloudFront Functions run a runtime that is ECMAScript 5.1 compliant with only
 * *some* ES6-12 features, and the list does not promise the ones below.
 * TypeScript downlevels **syntax** — arrow functions, `const`, template literals
 * are all fine and compile away — but it does not polyfill **library**
 * functions. So `Object.entries`, `Array.prototype.find`, `Array.prototype.includes`,
 * `String.prototype.startsWith`, `Map`, `Set` and `URLSearchParams` are avoided
 * here even where they would read better.
 *
 * The failure they would cause is the worst shape available: not a build error,
 * but a live ad silently serving the wrong page in production. `es5-safe.test.ts`
 * scans the source in this folder for them, so this cannot rot. It reads the
 * source rather than the build because that names the file and line where the
 * mistake was made; the two are equivalent for library calls, which TypeScript
 * passes through untouched whatever the target.
 *
 * # What it deliberately does not do
 *
 * It does not rewrite, redirect, fetch, cache, log or measure. Those belong to
 * the adapter, which is per-framework, sits on the request path, and must stay
 * short enough for the customer's own engineer to read at 2am.
 */

/** One rule, as Tailor writes it into the customer's CMS. */
export interface CampaignRoute {
  /** The page the ad points at, e.g. `/product/analytics`. */
  basePath: string;
  /**
   * The campaign parameters that must be present for this rule to apply.
   *
   * A SUBSET check, never an equality one — see `matchesParams`.
   */
  matchParams: Record<string, string>;
  /** The page to serve instead, e.g. `/product/analytics-enterprise-plan`. */
  targetPath: string;
}

/** The incoming request, reduced to the two things that decide the answer. */
export interface CampaignRequest {
  /** Path only, without the query string. */
  path: string;
  /** The query string, already parsed. Repeated keys: last one wins, as browsers do. */
  searchParams: Record<string, string>;
}

export interface MatchOptions {
  /**
   * Whether the campaign page actually exists yet.
   *
   * The rule and the page are separate CMS entries that a person publishes
   * separately, so the rule can go live first. Rewriting to a page that is not
   * there turns a live ad into a 404 for as long as nobody notices — and nobody
   * notices quickly, because the ad still looks fine.
   *
   * Omit it and no existence check happens, which is the right default for an
   * adapter that has no cheap way to answer. When supplied, a route whose target
   * is missing is skipped and the next-best rule is considered rather than the
   * whole request falling through.
   */
  pageExists?: (path: string) => boolean;
}

export interface CampaignMatch {
  /** The path to render instead. Never the path that was requested. */
  targetPath: string;
  /** The rule that won, so the caller can log or debug which one applied. */
  route: CampaignRoute;
}

/**
 * Trailing slashes and casing are formatting differences, not routing ones.
 *
 * `/pricing`, `/pricing/` and `/Pricing` are the same page to every router this
 * will meet, and the spellings arrive from different places: the rule is typed
 * by a person into a CMS field, the path comes off a real request. Comparing
 * them raw makes a rule silently never match, which looks exactly like a rule
 * that was never published — and a marketer who typed `/Pricing` has no way at
 * all to tell those two apart.
 *
 * **This is only ever used to COMPARE.** The path that gets served is
 * `route.targetPath` as authored, never this value, because a lowercased
 * rewrite would 404 on an origin whose routes really are case-sensitive. The
 * two questions are "do these name the same page" and "what do I ask for", and
 * only the first one is allowed to be lenient.
 */
const normalizePath = (value: string): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return '';
  if (trimmed.length > 1 && trimmed.charAt(trimmed.length - 1) === '/') {
    return trimmed.substring(0, trimmed.length - 1);
  }
  return trimmed;
};

/**
 * The target path in the form an adapter should actually serve.
 *
 * **Deliberately not `normalizePath`, and the difference is load-bearing.**
 * That one lowercases, because it builds a key for *comparing* two spellings of
 * the same page. This one is what gets written into `request.uri` or
 * `url.pathname`, and an origin whose routes are case-sensitive would 404 on a
 * lowercased path — so case is preserved exactly as the CMS holds it.
 *
 * What it does remove is the formatting noise that `isUsable` already validated
 * against: surrounding whitespace and a trailing slash. Returning the raw field
 * instead would mean the string that was checked and the string that is acted
 * on are different strings.
 */
const pathToServe = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length > 1 && trimmed.charAt(trimmed.length - 1) === '/') {
    return trimmed.substring(0, trimmed.length - 1);
  }
  return trimmed;
};

/**
 * Whether the request carries everything this rule asks for.
 *
 * **A subset check, and this is the failure mode that matters most.** A real ad
 * click never arrives carrying only what somebody targeted on: Google appends
 * `gclid`, Meta appends `fbclid`, the customer's analytics adds its own. A rule
 * demanding an exact parameter set matches every time in testing, where the URL
 * is typed by hand, and never once in production.
 *
 * Values compare case-insensitively because ad platforms are inconsistent about
 * campaign-name casing, and somebody who typed `Enterprise` in the ad and
 * `enterprise` in the rule meant one thing by both. Keys compare exactly: they
 * are `utm_*` conventions rather than free text, and loosening them would let
 * `UTM_Term` match a rule about something else.
 */
const matchesParams = (
  matchParams: Record<string, string>,
  searchParams: Record<string, string>
): boolean => {
  const keys = Object.keys(matchParams);
  // A rule naming no parameters would match every request to the base path,
  // which is a rule to serve a campaign page to organic traffic. Refuse it.
  if (keys.length === 0) return false;

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const required = matchParams[key];
    if (!Object.prototype.hasOwnProperty.call(searchParams, key)) return false;

    const actual = searchParams[key];
    if (typeof required !== 'string' || typeof actual !== 'string') return false;
    if (required.toLowerCase() !== actual.toLowerCase()) return false;
  }
  return true;
};

/**
 * Whether a value is a path on this site, and nothing else.
 *
 * **This is the security boundary of the whole package, and it has to live
 * here rather than in an adapter.** These strings come out of a CMS that the
 * customer's marketing team edits, and the adapters hand them straight to a URL
 * resolver: Next resolves the target against the request's own URL, and
 * Lambda@Edge writes it into `request.uri`. An absolute or protocol-relative
 * value therefore does not stay on the site — `new URL('//evil.example', page)`
 * resolves to a different origin, so one published entry would send a live ad's
 * traffic somewhere else entirely. A mistaken editor and a compromised editor
 * account produce the same string.
 *
 * What is rejected, and why each one is separate rather than covered by the
 * others:
 *
 * - **Anything not starting with a single `/`.** `https://…` is obvious;
 *   `//host` is the one that catches people, because it looks like a path and
 *   is a protocol-relative URL.
 * - **Backslashes.** A URL parser treats `\` as `/`, so `/\evil.example` is
 *   `//evil.example` by the time anything resolves it.
 * - **Control characters and space.** The URL spec says tab, LF and CR are
 *   *stripped before parsing*, so `/<tab>/evil.example` becomes
 *   `//evil.example` after this function has approved it.
 * - **`?` and `#`.** A target names a page, not a URL. Next would resolve a
 *   query and silently drop the campaign parameters the customer's analytics
 *   reads; CloudFront's `request.uri` may not contain one at all. Rejecting
 *   keeps the two adapters answering identically, which is the property that
 *   lets a customer move between them.
 *
 * `..` segments are deliberately NOT rejected. Both URL parsing and CloudFront
 * resolve them to a path on the same origin before anything acts on them, so
 * `/../../x` is `/x` and reaches nowhere a plain rule could not. Rejecting it
 * would refuse a legitimate, if odd, CMS value for no gain.
 */
const isInternalPath = (value: string): boolean => {
  if (value.charAt(0) !== '/') return false;
  if (value.charAt(1) === '/') return false;

  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x20) return false;
    if (value.charCodeAt(index) === 0x7f) return false;
    const char = value.charAt(index);
    if (char === '\\' || char === '?' || char === '#') return false;
  }
  return true;
};

/** A rule Tailor could not have written, and that nothing should act on. */
const isUsable = (route: CampaignRoute): boolean => {
  if (!route) return false;
  if (typeof route.basePath !== 'string') return false;
  if (typeof route.targetPath !== 'string') return false;
  if (!route.matchParams || typeof route.matchParams !== 'object') return false;

  // Normalize first, so the check sees the value the rest of the function will
  // compare and the adapter will act on, rather than what a person typed.
  const basePath = normalizePath(route.basePath);
  const targetPath = normalizePath(route.targetPath);
  if (!isInternalPath(basePath)) return false;
  if (!isInternalPath(targetPath)) return false;

  // A rule pointing at the page it came from would rewrite a request to itself.
  return basePath !== targetPath;
};

/**
 * Which of two matching rules wins.
 *
 * **More parameters wins**, because a rule naming `utm_term` AND `utm_source` is
 * describing a narrower slice of traffic than one naming `utm_term` alone, and
 * the narrower description is the one the marketer meant for that visitor.
 *
 * On a genuine tie, the target path — chosen for being total and stable rather
 * than for meaning anything. Two equally specific rules is a mistake in the
 * customer's content, and the failure it must not produce is a page that
 * alternates between versions depending on which CMS entry came back first.
 * Deterministic-and-arguably-wrong is debuggable; non-deterministic is not.
 */
const isBetterThan = (candidate: CampaignRoute, incumbent: CampaignRoute): boolean => {
  const candidateCount = Object.keys(candidate.matchParams).length;
  const incumbentCount = Object.keys(incumbent.matchParams).length;
  if (candidateCount !== incumbentCount) return candidateCount > incumbentCount;
  return candidate.targetPath < incumbent.targetPath;
};

/**
 * The campaign page this request should be served, or null to leave it alone.
 *
 * Null is the overwhelmingly common answer — organic traffic, a campaign with no
 * winner yet, a keyword nobody has tested. The caller renders the page it was
 * always going to render.
 *
 * @param routes every published rule; unusable ones are ignored rather than throwing
 * @param request the incoming path and its parsed query
 */
export const matchCampaignRoute = (
  routes: CampaignRoute[] | null | undefined,
  request: CampaignRequest | null | undefined,
  options?: MatchOptions
): CampaignMatch | null => {
  if (!routes || !routes.length || !request) return null;

  const path = normalizePath(request.path);
  if (path.length === 0) return null;

  const searchParams =
    request.searchParams && typeof request.searchParams === 'object' ? request.searchParams : {};

  // No query string, no campaign. Worth an early return rather than a loop:
  // organic traffic is the majority of every site's requests, and this is the
  // one place the common case can be answered without touching a rule at all.
  if (Object.keys(searchParams).length === 0) return null;

  const pageExists = options && typeof options.pageExists === 'function' ? options.pageExists : null;

  let best: CampaignRoute | null = null;
  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index];
    if (!isUsable(route)) continue;
    if (normalizePath(route.basePath) !== path) continue;
    if (!matchesParams(route.matchParams, searchParams)) continue;
    // Checked per candidate rather than once at the end, so a rule whose page is
    // not published yet loses to a less specific rule whose page is — instead of
    // taking the whole request down with it.
    //
    // Wrapped because this is the core's ONE call into caller code, and the
    // adapters are not the only callers this will have: the plan expects
    // customers to write their own Cloudflare Worker and Express glue straight
    // against this function. A throw from their predicate would then propagate
    // out of a function whose whole contract is that it answers. Treat it as
    // "cannot answer", which is what an absent predicate already means.
    if (pageExists) {
      let exists = false;
      try {
        // Asked about the path that will actually be served, not the raw CMS
        // field. A customer answering from their own route list with an exact
        // comparison would otherwise miss `/pricing/` against `/pricing`, and
        // refuse a page that exists.
        exists = pageExists(pathToServe(route.targetPath));
      } catch {
        exists = false;
      }
      if (!exists) continue;
    }
    if (best === null || isBetterThan(route, best)) best = route;
  }

  if (best === null) return null;
  // Cleaned, not raw, and not lowercased. `isUsable` validated a form of this
  // string that the raw field does not equal, so returning the raw one hands
  // the adapter a value nothing checked — and the adapter writes it straight
  // into `request.uri` or `url.pathname`. A target typed `/pricing/` in the CMS
  // reached CloudFront as `/pricing/`, a different key to every router and
  // cache downstream. Case survives: see `pathToServe`.
  return { targetPath: pathToServe(best.targetPath), route: best };
};
