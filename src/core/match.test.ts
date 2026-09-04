import { matchCampaignRoute, type CampaignRoute } from './match.js';

const route = (over: Partial<CampaignRoute> = {}): CampaignRoute => ({
  basePath: '/product/analytics',
  matchParams: { utm_term: 'enterprise plan' },
  targetPath: '/product/analytics-enterprise-plan',
  ...over
});

/** A real ad click, not a hand-typed URL. */
const adClick = (over: Record<string, string> = {}) => ({
  path: '/product/analytics',
  searchParams: {
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_term: 'enterprise plan',
    gclid: 'Cj0KCQjw_LmzBhDnARIsAOBmEQK9r7xY2v',
    ...over
  }
});

describe('a target path that would leave the site', () => {
  // These strings come from a CMS a marketing team edits, and both adapters
  // hand the result to a URL resolver. A mistaken editor and a compromised
  // editor account produce the same entry, so the core refuses rather than
  // trusting the adapter to notice.
  const hostile = [
    ['an absolute URL', 'https://evil.example/landing'],
    ['a protocol-relative URL', '//evil.example/landing'],
    ['a backslash, which a URL parser reads as a slash', '/\\evil.example'],
    ['a tab, which URL parsing strips before resolving', '/\t/evil.example'],
    ['a newline, same', '/\n/evil.example'],
    ['a carriage return, same', '/\r/evil.example'],
    ['a scheme with no slashes', 'javascript:alert(1)'],
    ['a bare hostname', 'evil.example/landing'],
    ['a relative path', 'landing'],
    ['a query string', '/landing?next=https://evil.example'],
    ['a fragment', '/landing#x'],
    ['an empty string', '']
  ];

  it.each(hostile)('refuses %s', (_label, targetPath) => {
    const routes = [
      { basePath: '/pricing', matchParams: { utm_term: 'x' }, targetPath: targetPath as string }
    ];
    expect(matchCampaignRoute(routes, { path: '/pricing', searchParams: { utm_term: 'x' } })).toBeNull();
  });

  it.each(hostile)('refuses the same shape in basePath: %s', (_label, basePath) => {
    const routes = [
      { basePath: basePath as string, matchParams: { utm_term: 'x' }, targetPath: '/pricing-x' }
    ];
    expect(matchCampaignRoute(routes, { path: '/pricing', searchParams: { utm_term: 'x' } })).toBeNull();
  });

  it('falls back to a sound rule rather than dropping the request', () => {
    // One bad entry must not take the campaign down — the same instinct as the
    // unpublished-page check.
    const routes: CampaignRoute[] = [
      { basePath: '/pricing', matchParams: { utm_term: 'x', utm_source: 'google' }, targetPath: '//evil.example' },
      { basePath: '/pricing', matchParams: { utm_term: 'x' }, targetPath: '/pricing-x' }
    ];
    const match = matchCampaignRoute(routes, {
      path: '/pricing',
      searchParams: { utm_term: 'x', utm_source: 'google' }
    });
    expect(match?.targetPath).toBe('/pricing-x');
  });

  it('accepts a `..` segment, which both runtimes resolve to a same-origin path', () => {
    // Documented as deliberate rather than an oversight: `/../../x` is `/x` to
    // a URL parser and to CloudFront, so it reaches nowhere a plain rule could
    // not, and refusing it would reject an odd but legitimate CMS value.
    const routes = [{ basePath: '/pricing', matchParams: { utm_term: 'x' }, targetPath: '/../x' }];
    const match = matchCampaignRoute(routes, { path: '/pricing', searchParams: { utm_term: 'x' } });
    expect(match?.targetPath).toBe('/../x');
  });

  it('still accepts an ordinary rooted path with a hyphen, dot or encoded space', () => {
    const routes = [
      { basePath: '/pricing', matchParams: { utm_term: 'x' }, targetPath: '/pricing-enterprise.v2%20b' }
    ];
    const match = matchCampaignRoute(routes, { path: '/pricing', searchParams: { utm_term: 'x' } });
    expect(match?.targetPath).toBe('/pricing-enterprise.v2%20b');
  });
});

describe('matchCampaignRoute', () => {
  it('serves the campaign page when the rule applies', () => {
    const match = matchCampaignRoute([route()], adClick());
    expect(match?.targetPath).toBe('/product/analytics-enterprise-plan');
  });

  it('names the rule that won, so a wrong answer is debuggable', () => {
    const match = matchCampaignRoute([route()], adClick());
    expect(match?.route.matchParams).toEqual({ utm_term: 'enterprise plan' });
  });

  it('leaves organic traffic completely alone', () => {
    // The overwhelmingly common case: no query string at all.
    const match = matchCampaignRoute([route()], {
      path: '/product/analytics',
      searchParams: {}
    });
    expect(match).toBeNull();
  });

  it('leaves a different page alone', () => {
    const match = matchCampaignRoute([route()], {
      ...adClick(),
      path: '/pricing'
    });
    expect(match).toBeNull();
  });

  it('leaves a different keyword alone', () => {
    const match = matchCampaignRoute([route()], adClick({ utm_term: 'competitor comparison' }));
    expect(match).toBeNull();
  });
});

/**
 * Failure mode 1 — the one that costs the most, because it passes every test
 * somebody writes by hand and fails every real request.
 */
describe('parameters the rule does not name', () => {
  it('matches an ad click carrying gclid and utm_source the rule never mentioned', () => {
    // A rule demanding an exact parameter set matches when a developer types the
    // URL and never once in production. Google appends gclid, Meta appends
    // fbclid, analytics adds its own.
    const match = matchCampaignRoute([route()], adClick());
    expect(match?.targetPath).toBe('/product/analytics-enterprise-plan');
  });

  it('still matches when the click carries a dozen unrelated parameters', () => {
    const match = matchCampaignRoute(
      [route()],
      adClick({
        fbclid: 'IwAR0',
        msclkid: 'abc',
        _ga: '2.1',
        mc_cid: 'x',
        ref: 'newsletter'
      })
    );
    expect(match).not.toBeNull();
  });

  it('refuses a rule naming no parameters, which would capture organic traffic', () => {
    // Such a rule says "serve the campaign page to everyone who lands here",
    // which is the one thing the campaign-page route exists to avoid.
    const match = matchCampaignRoute([route({ matchParams: {} })], adClick());
    expect(match).toBeNull();
  });

  it('requires every parameter the rule DOES name', () => {
    const twoParams = route({
      matchParams: { utm_term: 'enterprise plan', utm_source: 'bing' }
    });
    // utm_source is google on this click, not bing.
    expect(matchCampaignRoute([twoParams], adClick())).toBeNull();
  });

  it('refuses when a named parameter is absent entirely', () => {
    const match = matchCampaignRoute([route()], {
      path: '/product/analytics',
      searchParams: { utm_source: 'google' }
    });
    expect(match).toBeNull();
  });

  it('does not treat an inherited property as a present parameter', () => {
    // `searchParams` is parsed from a URL, so a key like `constructor` resolves
    // on the prototype and would read as present with a function value.
    const match = matchCampaignRoute([route({ matchParams: { constructor: 'x' } })], adClick());
    expect(match).toBeNull();
  });
});

/** Failure mode 2. */
describe('value casing', () => {
  it('matches when the ad says Enterprise and the rule says enterprise', () => {
    const enterprise = route({
      matchParams: { utm_campaign: 'enterprise' },
      targetPath: '/pricing-enterprise'
    });
    const match = matchCampaignRoute([enterprise], {
      path: '/product/analytics',
      searchParams: { utm_campaign: 'Enterprise' }
    });
    expect(match?.targetPath).toBe('/pricing-enterprise');
  });

  it('keeps parameter KEYS exact, so UTM_Term does not match a rule about utm_term', () => {
    // Keys are conventions rather than free text; loosening them lets a rule
    // about one thing capture traffic tagged for another.
    const match = matchCampaignRoute([route()], {
      path: '/product/analytics',
      searchParams: { UTM_Term: 'enterprise plan' }
    });
    expect(match).toBeNull();
  });
});

/** Failure mode 4. */
describe('a path spelled differently in the CMS than in the request', () => {
  // Found by reading a real hand-written implementation of this against ours:
  // it lowercased and we did not. A marketer who typed `/Pricing` gets a rule
  // that silently never matches, which is indistinguishable from a rule nobody
  // published — the exact failure normalizePath exists to prevent.
  it('matches a basePath the marketer capitalised', () => {
    const match = matchCampaignRoute([route({ basePath: '/Product/Analytics' })], adClick());
    expect(match?.targetPath).toBe('/product/analytics-enterprise-plan');
  });

  it('matches a request path the visitor capitalised', () => {
    const match = matchCampaignRoute([route()], {
      ...adClick(),
      path: '/Product/Analytics'
    });
    expect(match).not.toBeNull();
  });

  it('serves the target path exactly as authored, never lowercased', () => {
    // Comparison is lenient; what gets REQUESTED is not. A lowercased rewrite
    // would 404 on an origin whose routes really are case-sensitive.
    const match = matchCampaignRoute([route({ targetPath: '/Product/Analytics-LLM' })], adClick());
    expect(match?.targetPath).toBe('/Product/Analytics-LLM');
  });

  it('still catches a self-referential rule that differs only in case', () => {
    const match = matchCampaignRoute(
      [route({ basePath: '/product/analytics', targetPath: '/Product/Analytics' })],
      adClick()
    );
    expect(match).toBeNull();
  });
});

describe('a target page that is not published yet', () => {
  const exists = (published: string[]) => (path: string) => published.indexOf(path) !== -1;

  it('does not rewrite to a page that does not exist', () => {
    // The rule and the page are separate entries published separately, so the
    // rule can go live first. Rewriting turns a live ad into a 404 for as long
    // as nobody notices — and nobody notices, because the ad still looks fine.
    const match = matchCampaignRoute([route()], adClick(), { pageExists: exists([]) });
    expect(match).toBeNull();
  });

  it('rewrites once the page is published', () => {
    const match = matchCampaignRoute([route()], adClick(), {
      pageExists: exists(['/product/analytics-enterprise-plan'])
    });
    expect(match).not.toBeNull();
  });

  it('falls back to a less specific rule whose page DOES exist', () => {
    // Skipping is per candidate, not per request: one unpublished page must not
    // take down a campaign that has a working rule behind it.
    const specific = route({
      matchParams: { utm_term: 'enterprise plan', utm_source: 'google' },
      targetPath: '/unpublished'
    });
    const broad = route({ targetPath: '/published' });
    const match = matchCampaignRoute([specific, broad], adClick(), {
      pageExists: exists(['/published'])
    });
    expect(match?.targetPath).toBe('/published');
  });

  it('checks nothing when the caller cannot answer cheaply', () => {
    const match = matchCampaignRoute([route()], adClick());
    expect(match).not.toBeNull();
  });

  it('treats a predicate that throws as "cannot answer" rather than propagating', () => {
    // This is the core's one call into caller code, and the adapters are not
    // its only callers — the plan expects customers to write Worker and Express
    // glue straight against it. A throw must not escape a function whose whole
    // contract is that it answers.
    const throwing = () => {
      throw new Error('the customer manifest is not loaded yet');
    };
    expect(() => matchCampaignRoute([route()], adClick(), { pageExists: throwing })).not.toThrow();
    expect(matchCampaignRoute([route()], adClick(), { pageExists: throwing })).toBeNull();
  });

  it('falls back to a sound rule when a more specific one makes the predicate throw', () => {
    const specific = route({
      matchParams: { utm_term: 'enterprise plan', utm_source: 'google' },
      targetPath: '/explodes'
    });
    const broad = route({ targetPath: '/published' });
    const match = matchCampaignRoute([specific, broad], adClick(), {
      pageExists: (path: string) => {
        if (path === '/explodes') throw new Error('boom');
        return path === '/published';
      }
    });
    expect(match?.targetPath).toBe('/published');
  });
});

/** Failure mode 5. */
describe('two rules matching one request', () => {
  it('prefers the rule naming more parameters', () => {
    const broad = route({ targetPath: '/broad' });
    const narrow = route({
      matchParams: { utm_term: 'enterprise plan', utm_source: 'google' },
      targetPath: '/narrow'
    });
    expect(matchCampaignRoute([broad, narrow], adClick())?.targetPath).toBe('/narrow');
    // And the answer does not depend on which came back from the CMS first.
    expect(matchCampaignRoute([narrow, broad], adClick())?.targetPath).toBe('/narrow');
  });

  it('breaks a genuine tie deterministically, whatever the input order', () => {
    // Two equally specific rules is a mistake in the customer's content. The
    // failure it must not produce is a page that alternates between versions.
    const a = route({ targetPath: '/aaa' });
    const b = route({ targetPath: '/zzz' });
    expect(matchCampaignRoute([a, b], adClick())?.targetPath).toBe('/aaa');
    expect(matchCampaignRoute([b, a], adClick())?.targetPath).toBe('/aaa');
  });
});

describe('trailing slashes', () => {
  it('matches a rule typed with a trailing slash against a path without one', () => {
    // The rule is typed by a person into a CMS field; the path comes off a real
    // request. Comparing them raw makes the rule silently never match, which
    // looks exactly like a rule nobody published.
    const match = matchCampaignRoute([route({ basePath: '/product/analytics/' })], adClick());
    expect(match).not.toBeNull();
  });

  it('matches a request path with a trailing slash against a rule without one', () => {
    const match = matchCampaignRoute([route()], {
      ...adClick(),
      path: '/product/analytics/'
    });
    expect(match).not.toBeNull();
  });

  it('still treats the site root as the root', () => {
    const rootRule = route({ basePath: '/', targetPath: '/home-campaign' });
    const match = matchCampaignRoute([rootRule], { ...adClick(), path: '/' });
    expect(match?.targetPath).toBe('/home-campaign');
  });
});

describe('rules it refuses to act on', () => {
  it('ignores a rule pointing at the page it came from', () => {
    // A self-referential rewrite is either a loop or a no-op depending on the
    // framework, and neither is what anybody meant.
    const selfRef = route({ targetPath: '/product/analytics' });
    expect(matchCampaignRoute([selfRef], adClick())).toBeNull();
  });

  it('ignores a rule whose target differs only by a trailing slash', () => {
    const selfRef = route({ targetPath: '/product/analytics/' });
    expect(matchCampaignRoute([selfRef], adClick())).toBeNull();
  });

  it('ignores malformed rules without throwing, and still uses the good one', () => {
    // Rules come from a CMS a person edits. One bad entry must not take the
    // campaign down; every error path here has to end at "serve the page".
    const bad = [
      null,
      undefined,
      {},
      route({ basePath: '' }),
      route({ targetPath: '' }),
      route({ matchParams: null as never })
    ] as CampaignRoute[];
    const match = matchCampaignRoute([...bad, route()], adClick());
    expect(match?.targetPath).toBe('/product/analytics-enterprise-plan');
  });

  it('ignores a non-string parameter value rather than coercing it', () => {
    const weird = route({ matchParams: { utm_term: 42 as never } });
    expect(matchCampaignRoute([weird], adClick())).toBeNull();
  });
});

describe('being handed nothing', () => {
  it('answers null for every empty or absent input', () => {
    expect(matchCampaignRoute(null, adClick())).toBeNull();
    expect(matchCampaignRoute(undefined, adClick())).toBeNull();
    expect(matchCampaignRoute([], adClick())).toBeNull();
    expect(matchCampaignRoute([route()], null)).toBeNull();
    expect(matchCampaignRoute([route()], undefined)).toBeNull();
  });

  it('answers null for an unusable path rather than matching everything', () => {
    expect(matchCampaignRoute([route()], { path: '', searchParams: { a: 'b' } })).toBeNull();
    expect(matchCampaignRoute([route()], { path: '   ', searchParams: { a: 'b' } })).toBeNull();
  });

  it('survives searchParams that is not an object', () => {
    const match = matchCampaignRoute([route()], {
      path: '/product/analytics',
      searchParams: 'utm_term=x' as never
    });
    expect(match).toBeNull();
  });
});

describe('it never mutates what it was given', () => {
  it('leaves the routes and the request untouched', () => {
    // The caller may be holding a cached rule set shared across requests, and a
    // mutation here would be a bug that only appears under load.
    const routes = [route()];
    const request = adClick();
    const routesBefore = JSON.stringify(routes);
    const requestBefore = JSON.stringify(request);

    matchCampaignRoute(routes, request);

    expect(JSON.stringify(routes)).toBe(routesBefore);
    expect(JSON.stringify(request)).toBe(requestBefore);
  });
});

describe('the target path it hands back', () => {
  // Every check in match.ts runs on the NORMALIZED target: `isUsable` validates
  // it and the self-reference guard compares it. Returning the raw CMS string
  // meant the value that was checked and the value the adapter acts on were
  // different strings, and the adapter writes it straight into `request.uri`
  // or `url.pathname`.
  it('is normalized, not the raw string the CMS holds', () => {
    const match = matchCampaignRoute(
      [route({ targetPath: '/product/analytics-enterprise/' })],
      adClick()
    );
    expect(match?.targetPath).toBe('/product/analytics-enterprise');
  });

  it('drops stray whitespace somebody typed into the field', () => {
    const match = matchCampaignRoute(
      [route({ targetPath: '  /product/analytics-enterprise  ' })],
      adClick()
    );
    expect(match?.targetPath).toBe('/product/analytics-enterprise');
  });

  it('still reports the rule exactly as authored, so it can be found in the CMS', () => {
    // `route` is for a human going to look the entry up, so it is deliberately
    // NOT normalized. The two fields answer different questions.
    const authored = '/product/analytics-enterprise/';
    const match = matchCampaignRoute([route({ targetPath: authored })], adClick());
    expect(match?.route.targetPath).toBe(authored);
  });
});
