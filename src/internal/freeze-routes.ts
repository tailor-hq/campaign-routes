import { isParamMatcher, type CampaignRoute, type ParamMatcher } from '../core/index.js';

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
    for (const key of Object.keys(route.matchParams)) {
      const matcher = route.matchParams[key];
      if (typeof matcher === 'object' && matcher !== null) {
        if (Object.prototype.hasOwnProperty.call(matcher, 'oneOf')) Object.freeze((matcher as { oneOf: string[] }).oneOf);
        Object.freeze(matcher);
      }
    }
    Object.freeze(route.matchParams);
    Object.freeze(route);
  }
  return Object.freeze(routes) as CampaignRoute[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A fresh copy of a matcher, so the caller's own object is never the cached
 * one. Dispatches on the one own key `isParamMatcher` established, never with
 * `in`, which would read an inherited property as the operator.
 */
const copyMatcher = (matcher: ParamMatcher): ParamMatcher => {
  if (typeof matcher === 'string') return matcher;
  const operator = Object.keys(matcher)[0];
  const operand = (matcher as Record<string, unknown>)[operator!];
  if (operator === 'contains') return { contains: operand as string };
  if (operator === 'startsWith') return { startsWith: operand as string };
  if (operator === 'endsWith') return { endsWith: operand as string };
  return { oneOf: (operand as string[]).slice() };
};

/**
 * Read rules out of input this package did not build — an endpoint's JSON, a
 * caller's bootstrap, a CMS entry — keeping the well-formed ones as fresh,
 * leaf-frozen copies and skipping the rest one at a time.
 *
 * One malformed rule must not take the payload down with it. The matcher
 * skips a bad rule and routes on the others, and an endpoint read that threw
 * on one would be a failed refresh: on a cold cache that is every campaign
 * off, on a warm one it is stale rules kept. Copying is what makes the freeze
 * safe — the caller's own objects are left exactly as they were. A parameter
 * whose matcher is not one the core acts on is dropped, and a rule whose
 * parameters then filter down to nothing is dropped too, since a rule that
 * names no parameter would match every visitor.
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
    const params: Record<string, ParamMatcher> = {};
    for (const key of Object.keys(matchParams)) {
      const matcher = matchParams[key];
      if (isParamMatcher(matcher)) params[key] = copyMatcher(matcher);
    }
    if (Object.keys(params).length === 0) continue;
    routes.push({ basePath, targetPath, matchParams: params });
  }
  return freezeRoutes(routes);
};
