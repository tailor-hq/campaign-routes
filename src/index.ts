/**
 * `@tailor-ai/campaign-routes` — serve the campaign page a visitor should get,
 * from rules held in your own CMS.
 *
 * The default entry is the **core only**: one pure function, no dependencies, no
 * network, no framework. That is deliberate — a CloudFront Function has a 10KB
 * code budget, and importing this must never drag an adapter in behind it.
 *
 * The adapters are separate entry points, so you take only the one your stack
 * uses:
 *
 * - `@tailor-ai/campaign-routes/next` — Next.js middleware
 * - `@tailor-ai/campaign-routes/endpoint` — read the rules from your own app
 * - `@tailor-ai/campaign-routes/contentful` — shape Contentful entries into
 *   rules, and fetch them directly where a runtime has no better source
 *
 * `next` + `endpoint` is the pairing behind a real deploy.
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
