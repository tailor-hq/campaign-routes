import type { CampaignRoute } from '../core/index.js';

/**
 * Freeze rules to the leaf. Every request on an isolate gets the same rule
 * objects by reference, and they are handed to code this package does not
 * control — a `pageExists` helper, an `onMatch` that "normalizes" parameters
 * in place. Freezing only the array left each rule and its `matchParams` open,
 * so one such edit would have rerouted every later visitor for as long as the
 * cache lived. The cast keeps the `CampaignRoute[]` the sources hand out; the
 * freeze is enforced by the runtime, not the type.
 */
export const freezeRoutes = (routes: CampaignRoute[]): CampaignRoute[] => {
  for (const route of routes) {
    Object.freeze(route.matchParams);
    Object.freeze(route);
  }
  return Object.freeze(routes) as CampaignRoute[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Read rules out of input this package did not build — an endpoint's JSON, a
 * caller's bootstrap — keeping the well-formed ones as fresh, leaf-frozen
 * copies and skipping the rest one at a time.
 *
 * One malformed rule must not take the payload down with it. The matcher and
 * the Contentful source both skip a bad rule and route on the others, and an
 * endpoint read that threw on one would be a failed refresh: on a cold cache
 * that is every campaign off, on a warm one it is stale rules kept. Copying is
 * what makes the freeze safe — the caller's own objects are left exactly as
 * they were. A rule whose parameters filter down to nothing is dropped, since
 * a rule that names no parameter would match every visitor.
 */
export const normalizeRoutes = (value: unknown): CampaignRoute[] => {
  if (!Array.isArray(value)) return [];
  const routes: CampaignRoute[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const { basePath, targetPath, matchParams } = item;
    if (typeof basePath !== 'string' || typeof targetPath !== 'string' || !isRecord(matchParams)) {
      continue;
    }
    const params: Record<string, string> = {};
    for (const key of Object.keys(matchParams)) {
      const param = matchParams[key];
      if (typeof param === 'string') params[key] = param;
    }
    if (Object.keys(params).length === 0) continue;
    routes.push({ basePath, targetPath, matchParams: params });
  }
  return freezeRoutes(routes);
};
