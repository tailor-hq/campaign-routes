/**
 * Where the rules come from.
 *
 * # Why this is in core, and not next to the Contentful adapter
 *
 * This is the seam the package extends along. A second CMS is a new
 * implementation of this interface and nothing else: the core does not change,
 * and neither does any runtime adapter, because none of them knows where the
 * rules came from. Contentful is the first source, not the only shape a source
 * can have.
 *
 * That only reads as true if the contract lives somewhere a second CMS would
 * look. It was originally declared inside `contentful.ts`, which made the
 * import for a WordPress adapter
 * `import type { RouteSource } from '@tailor-ai/campaign-routes/contentful'`
 * — an import path that says the opposite of what the architecture does.
 *
 * # One declaration, because three had already drifted
 *
 * There were three: `RouteSource` here in Contentful, and a `RouteSourceLike`
 * in each of the two runtime adapters. By the time they were collapsed they
 * described three different shapes — the Next one had grown `origin` and
 * `pageExists`, the Lambda@Edge one had neither, and Contentful's was
 * promise-only. Nothing made them disagree on purpose; nothing could have made
 * them agree either, because a duplicated interface has no mechanism that
 * keeps the copies honest.
 *
 * The union below is the superset, so every previous shape satisfies it.
 *
 * # Why a type belongs in the ES 5.1 folder at all
 *
 * An interface has no runtime existence, so it costs a CloudFront Function
 * nothing. Keeping it here means the contract and the function that consumes
 * its output are read together.
 *
 * # Writing your own
 *
 * Anything with a `getRoutes` is a source. The whole of an in-memory one:
 *
 * ```ts
 * const source: RouteSource = { getRoutes: () => myRules };
 * ```
 *
 * Two obligations, both learned from the Contentful adapter and neither
 * enforceable by the type:
 *
 * - **Never throw, and never reject.** Answer with the last good rules, or an
 *   empty array. Every adapter treats "no rules" as "serve the page you were
 *   going to serve", so a source that throws turns a content-delivery blip
 *   into a broken page.
 * - **Cache, and collapse concurrent fetches.** `getRoutes` is called on
 *   requests carrying a query string, which is every ad click. A source that
 *   fetches per call aims that traffic at whatever it reads from.
 */

import type { CampaignRoute } from './core/index.js';

export interface RouteSource {
  /**
   * The current rules.
   *
   * Synchronous is allowed on purpose, and is not a convenience: rules read
   * from a CloudFront KeyValueStore, bundled at build time, or already held in
   * memory are available without a promise, and a runtime that cannot await
   * should not have to.
   *
   * `origin` is the requesting site's own origin, passed so that a source
   * reading an endpoint on this site works unchanged on a preview deploy, a
   * branch URL and production without an environment variable per
   * environment. A source that does not need it ignores the argument, which is
   * why it is optional rather than required.
   */
  getRoutes: (origin?: string) => CampaignRoute[] | Promise<CampaignRoute[]>;
  /**
   * Whether a path is one the site actually serves, if the source can answer.
   *
   * Optional because most sources cannot. A source that reads an endpoint
   * inside the app can, since it sees the route list beside the rules, and
   * answering here turns on the "never rewrite to a page that is not published
   * yet" protection without the customer having to wire anything up.
   *
   * A caller's own `pageExists` outranks this one. See each adapter.
   *
   * `origin` is the same value the adapter passed to `getRoutes`, so a source
   * that keeps one page list per hostname can answer from the right one. A
   * source that keeps one list ignores it.
   */
  pageExists?: (path: string, origin?: string) => boolean;
}
