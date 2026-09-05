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
