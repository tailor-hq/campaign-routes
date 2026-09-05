/**
 * `@tailor-ai/campaign-routes` — serve the campaign page a visitor should get,
 * from rules your marketing team publishes in Contentful, on a Next.js site.
 *
 * A Contentful + Next.js install uses three entry points, one per step of the
 * README's "How it works":
 *
 * - `@tailor-ai/campaign-routes/contentful` — turn Contentful entries into
 *   rules, inside your route handler
 * - `@tailor-ai/campaign-routes/endpoint` — build the rules payload there, and
 *   read it from the middleware
 * - `@tailor-ai/campaign-routes/next` — decide per request, from `middleware.ts`
 *
 * This default entry is the **decision alone**: one pure function, no
 * dependencies, no network, no framework, for a site that is on neither. It is
 * kept that small on purpose so importing it never drags an adapter in behind
 * it, and so it runs anywhere JavaScript does, down to an edge function with a
 * code budget.
 *
 * # What is deliberately NOT exported
 *
 * A CloudFront/Lambda@Edge adapter lives in `examples/lambda-edge`, sharing
 * this core and its tests, and is not a published entry point. It has never run
 * in that runtime — and a published export is a promise a README disclaimer
 * cannot walk back. The asymmetry decides it: adding an entry point once a real
 * deploy has proved it is a minor version, and removing one afterwards is a
 * breaking change on a package whose whole pitch is a frictionless install.
 *
 * `package-shape.test.ts` pins that, so it cannot be undone by accident.
 *
 * Contentful is the first source, not the only shape one can take. Writing
 * another — a different CMS, a build-time JSON file, a KeyValueStore — means
 * implementing `RouteSource`, which is exported here rather than from any
 * adapter precisely so that a second one has somewhere neutral to look.
 */
export * from './core/index.js';

// Type-only, so it adds nothing to the 10KB budget above. It sits outside
// `core/` because that folder is held to ES 5.1 and to being synchronous, and
// this contract has to name `Promise` for every source that fetches.
export type { RouteSource } from './route-source.js';
