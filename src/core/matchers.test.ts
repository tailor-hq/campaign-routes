import { isParamMatcher, matchCampaignRoute, type CampaignRoute } from './match.js';

const rule = (matchParams: CampaignRoute['matchParams'], over: Partial<CampaignRoute> = {}): CampaignRoute => ({
  basePath: '/pricing',
  targetPath: '/pricing-enterprise',
  matchParams,
  ...over
});

const click = (searchParams: Record<string, string>, path = '/pricing') => ({ path, searchParams });

const target = (routes: CampaignRoute[], request: ReturnType<typeof click>) =>
  matchCampaignRoute(routes, request)?.targetPath ?? null;

describe('parameter matchers', () => {
  it('reads a plain string as an exact, case-insensitive match', () => {
    expect(target([rule({ utm_term: 'Enterprise Plan' })], click({ utm_term: 'enterprise plan' }))).toBe('/pricing-enterprise');
    expect(target([rule({ utm_term: 'enterprise plan' })], click({ utm_term: 'enterprise plans' }))).toBeNull();
  });

  it.each([
    ['a trailing wildcard', 'enterprise*', 'enterprise plan', true],
    ['a trailing wildcard, nothing after it', 'enterprise*', 'enterprise', true],
    ['a trailing wildcard, wrong start', 'enterprise*', 'the enterprise', false],
    ['a leading wildcard', '*pricing', 'enterprise pricing', true],
    ['both ends', '*langsmith*', 'best langsmith alternative', true],
    ['both ends, absent', '*langsmith*', 'best datadog alternative', false],
    ['segments in order', 'a*b*c', 'a-x-b-y-c', true],
    ['segments out of order', 'a*b*c', 'a-c-b', false],
    ['a lone star, any value', '*', 'anything at all', true],
    ['a lone star, empty value', '*', '', true],
    ['case', 'Enterprise*', 'ENTERPRISE PLAN', true],
    ['a star that would backtrack in a regex', 'a*a*a*a*a*b', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', false]
  ])('reads a string with a star as a wildcard: %s', (_label, pattern, value, expected) => {
    expect(target([rule({ utm_term: pattern })], click({ utm_term: value })) !== null).toBe(expected);
  });

  it.each([
    ['contains', { contains: 'langsmith' }, 'best LangSmith alternative', true],
    ['contains, absent', { contains: 'langsmith' }, 'best datadog alternative', false],
    ['startsWith', { startsWith: 'enterprise' }, 'Enterprise plan', true],
    ['startsWith, elsewhere', { startsWith: 'enterprise' }, 'the enterprise plan', false],
    ['endsWith', { endsWith: 'pricing' }, 'enterprise PRICING', true],
    ['endsWith, elsewhere', { endsWith: 'pricing' }, 'pricing plans', false],
    ['endsWith, shorter value', { endsWith: 'pricing' }, 'ing', false],
    ['oneOf, exact', { oneOf: ['a', 'b'] }, 'B', true],
    ['oneOf, with a wildcard entry', { oneOf: ['a', 'enterprise*'] }, 'enterprise plan', true],
    ['oneOf, none', { oneOf: ['a', 'b'] }, 'c', false]
  ])('reads an operator object: %s', (_label, matcher, value, expected) => {
    expect(target([rule({ utm_term: matcher as CampaignRoute['matchParams'][string] })], click({ utm_term: value })) !== null).toBe(expected);
  });

  it('still needs every named parameter present', () => {
    expect(target([rule({ utm_term: '*', utm_source: 'google' })], click({ utm_term: 'x' }))).toBeNull();
    expect(target([rule({ utm_term: '*', utm_source: 'google' })], click({ utm_term: 'x', utm_source: 'google' }))).toBe('/pricing-enterprise');
  });

  it.each([
    ['a regex-shaped object', { regex: 'a.*' }],
    ['two operators at once', { contains: 'a', startsWith: 'b' }],
    ['a non-string operand', { contains: 5 }],
    ['an empty operand', { contains: '' }],
    ['an empty oneOf', { oneOf: [] }],
    ['a oneOf with a non-string', { oneOf: ['a', 1] }],
    ['an array', ['a', 'b']],
    ['a number', 7],
    ['null', null]
  ])('drops a rule whose matcher is %s, rather than guessing', (_label, matcher) => {
    expect(isParamMatcher(matcher)).toBe(false);
    const routes = [rule({ utm_term: matcher as never })];
    expect(target(routes, click({ utm_term: 'a' }))).toBeNull();
  });
});

describe('a section wildcard in basePath', () => {
  const section = rule({ utm_campaign: 'spring' }, { basePath: '/blog/*', targetPath: '/spring-offer' });

  it('covers the section root and every page under it', () => {
    expect(target([section], click({ utm_campaign: 'spring' }, '/blog'))).toBe('/spring-offer');
    expect(target([section], click({ utm_campaign: 'spring' }, '/blog/'))).toBe('/spring-offer');
    expect(target([section], click({ utm_campaign: 'spring' }, '/blog/post-1'))).toBe('/spring-offer');
    expect(target([section], click({ utm_campaign: 'spring' }, '/blog/2026/post'))).toBe('/spring-offer');
  });

  it('does not cover a sibling that merely shares the prefix', () => {
    expect(target([section], click({ utm_campaign: 'spring' }, '/blogroll'))).toBeNull();
    expect(target([section], click({ utm_campaign: 'spring' }, '/'))).toBeNull();
  });

  it('covers the whole site as /*', () => {
    const everywhere = rule({ utm_campaign: 'spring' }, { basePath: '/*', targetPath: '/spring-offer' });
    expect(target([everywhere], click({ utm_campaign: 'spring' }, '/'))).toBe('/spring-offer');
    expect(target([everywhere], click({ utm_campaign: 'spring' }, '/anything/deep'))).toBe('/spring-offer');
  });

  it('never rewrites the target page to itself', () => {
    // /blog/* covers /blog/spring-offer, and a rule serving that page must
    // leave a request for it alone rather than loop.
    const self = rule({ utm_campaign: 'spring' }, { basePath: '/blog/*', targetPath: '/blog/spring-offer' });
    expect(target([self], click({ utm_campaign: 'spring' }, '/blog/spring-offer'))).toBeNull();
    expect(target([self], click({ utm_campaign: 'spring' }, '/blog/other'))).toBe('/blog/spring-offer');
  });

  it('refuses a star in the target, which names pages to match and never a page to serve', () => {
    expect(target([rule({ utm_campaign: 'x' }, { targetPath: '/offers/*' })], click({ utm_campaign: 'x' }))).toBeNull();
  });
});

describe('which rule wins', () => {
  const click2 = click({ utm_term: 'enterprise plan', utm_source: 'google' }, '/pricing');

  it('prefers the exact page over a section wildcard', () => {
    const routes = [
      rule({ utm_term: '*' }, { basePath: '/*', targetPath: '/generic' }),
      rule({ utm_term: '*' }, { basePath: '/pricing', targetPath: '/exact' })
    ];
    expect(target(routes, click2)).toBe('/exact');
  });

  it('prefers the longer section prefix among wildcards', () => {
    const routes = [
      rule({ utm_term: '*' }, { basePath: '/*', targetPath: '/site-wide' }),
      rule({ utm_term: '*' }, { basePath: '/pricing/*', targetPath: '/pricing-section' })
    ];
    expect(target(routes, click({ utm_term: 'x' }, '/pricing/teams'))).toBe('/pricing-section');
  });

  it('prefers more parameters, then an exact value over a pattern', () => {
    const routes = [
      rule({ utm_term: 'enterprise*' }, { targetPath: '/pattern' }),
      rule({ utm_term: 'enterprise plan' }, { targetPath: '/exact' }),
      rule({ utm_term: '*', utm_source: '*' }, { targetPath: '/two-params' })
    ];
    expect(target(routes, click2)).toBe('/two-params');
    expect(target(routes.slice(0, 2), click2)).toBe('/exact');
  });
});
