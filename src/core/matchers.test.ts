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

describe('a star in a path', () => {
  it.each(['/blog/*', '/*', '/blog*', '/blog/**', '/bl*g'])('drops a rule whose basePath is %s: a rule is one page, never a section', (basePath) => {
    // A rule replaces the whole page with one target, so a section wildcard
    // would collapse every page it matched into one and a typo would take a
    // section with it. Section-wide matching is for tools that change an
    // element on each page; this is a rewrite.
    expect(target([rule({ utm_term: 'x' }, { basePath, targetPath: '/offer' })], click({ utm_term: 'x' }, '/blog/post'))).toBeNull();
    expect(target([rule({ utm_term: 'x' }, { basePath, targetPath: '/offer' })], click({ utm_term: 'x' }, '/blog'))).toBeNull();
  });

  it('refuses a star in the target, which could only ever be served literally', () => {
    expect(target([rule({ utm_campaign: 'x' }, { targetPath: '/offers/*' })], click({ utm_campaign: 'x' }))).toBeNull();
  });
});

describe('which rule wins', () => {
  const click2 = click({ utm_term: 'enterprise plan', utm_source: 'google' }, '/pricing');

  it('prefers an exact keyword over a catch-all of lone stars, however many the catch-all names', () => {
    // Nearly every ad click carries utm_source and utm_term, so two lone stars
    // describe nearly everyone; the rule naming the actual keyword is the one
    // the marketer meant for this click.
    const routes = [
      rule({ utm_term: 'enterprise*' }, { targetPath: '/pattern' }),
      rule({ utm_term: 'enterprise plan' }, { targetPath: '/exact' }),
      rule({ utm_term: '*', utm_source: '*' }, { targetPath: '/catch-all' })
    ];
    expect(target(routes, click2)).toBe('/exact');
    expect(target([routes[0]!, routes[2]!], click2)).toBe('/pattern');
  });

  it('prefers more parameters once the exact values are equal', () => {
    const routes = [
      rule({ utm_term: 'enterprise plan' }, { targetPath: '/one' }),
      rule({ utm_term: 'enterprise plan', utm_source: 'google' }, { targetPath: '/two' })
    ];
    expect(target(routes, click2)).toBe('/two');
  });

  it('breaks a tie between two patterns the same way every time', () => {
    const routes = [
      rule({ utm_term: { contains: 'enterprise' } }, { targetPath: '/b-contains' }),
      rule({ utm_term: 'enterprise*' }, { targetPath: '/a-wildcard' })
    ];
    expect(target(routes, click2)).toBe('/a-wildcard');
    expect(target(routes.slice().reverse(), click2)).toBe('/a-wildcard');
  });

  it('counts a oneOf as a pattern even when every entry is exact', () => {
    const routes = [
      rule({ utm_term: { oneOf: ['enterprise plan', 'other'] } }, { targetPath: '/one-of' }),
      rule({ utm_term: 'enterprise plan' }, { targetPath: '/exact' })
    ];
    expect(target(routes, click2)).toBe('/exact');
  });
});

describe('wildcard corners', () => {
  it.each([
    ['a suffix that would overlap the prefix', 'ab*b', 'ab', false],
    ['a suffix that fits after the prefix', 'ab*b', 'abb', true],
    ['a doubled star', 'a**b', 'a-anything-b', true],
    ['an overlapping middle segment', '*aa*a', 'aaa', true],
    ['an overlapping middle segment, too short', '*aa*a', 'aa', false]
  ])('%s', (_label, pattern, value, expected) => {
    expect(target([rule({ utm_term: pattern })], click({ utm_term: value })) !== null).toBe(expected);
  });

  it('reads an empty plain string as "present and empty"', () => {
    expect(target([rule({ utm_term: '' })], click({ utm_term: '' }))).toBe('/pricing-enterprise');
    expect(target([rule({ utm_term: '' })], click({ utm_term: 'x' }))).toBeNull();
  });

  it.each([
    ['a oneOf that is a string', { oneOf: 'a' }],
    ['a contains that is a list', { contains: ['a'] }]
  ])('refuses %s', (_label, matcher) => {
    expect(isParamMatcher(matcher)).toBe(false);
  });

  it('ignores an inherited operator: only an own key names one', () => {
    // A matcher built from an object with an inherited `contains` and an own
    // `oneOf` passes the own-key check and must be read as the oneOf.
    const inherited = Object.create({ contains: 'zzz' }) as { oneOf: string[] };
    inherited.oneOf = ['enterprise plan'];
    expect(target([rule({ utm_term: inherited as never })], click({ utm_term: 'enterprise plan' }))).toBe('/pricing-enterprise');
  });

});
