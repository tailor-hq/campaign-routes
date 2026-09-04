/**
 * The core: deciding which campaign page a request should be served.
 *
 * Everything in this folder is held to ES 5.1 built-ins so it can run inside a
 * CloudFront Function, which is the only interception point on a statically
 * exported site. `es5-safe.test.ts` enforces that against the source.
 *
 * The adapters deliberately live outside this folder. They run in modern
 * runtimes, and holding them to the same rule would be a cost paid for nothing.
 */
export {
  matchCampaignRoute,
  type CampaignMatch,
  type CampaignRequest,
  type CampaignRoute,
  type MatchOptions
} from './match.js';
