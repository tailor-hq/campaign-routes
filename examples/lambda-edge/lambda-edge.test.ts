import type { CampaignRoute } from '../../src/core/index.js';
import { createCampaignRouteHandler, parseQueryString, type CloudFrontEvent } from './lambda-edge.js';

const ROUTES: CampaignRoute[] = [
  {
    basePath: '/product/analytics',
    matchParams: { utm_term: 'enterprise plan' },
    targetPath: '/product/analytics-enterprise-plan'
  }
];

const source = (routes: CampaignRoute[] = ROUTES) => ({ getRoutes: async () => routes });

const viewerRequest = (uri: string, querystring: string): CloudFrontEvent => ({
  Records: [{ cf: { request: { uri, querystring } } }]
});

describe('parseQueryString', () => {
  it('reads an ordinary pair', () => {
    expect(parseQueryString('utm_source=google')).toEqual({ utm_source: 'google' });
  });

  it('reads a plus as a space, which is what Google actually sends', () => {
    // `decodeURIComponent` alone leaves the plus in place, so a rule typed as
    // "enterprise plan" would silently never match its own traffic.
    expect(parseQueryString('utm_term=enterprise+plan')).toEqual({
      utm_term: 'enterprise plan'
    });
  });

  it('reads percent-encoded spaces too', () => {
    expect(parseQueryString('utm_term=enterprise%20plan')).toEqual({
      utm_term: 'enterprise plan'
    });
  });

  it('keeps a value that legitimately contains an equals sign', () => {
    expect(parseQueryString('redirect=/a?b=c')).toEqual({ redirect: '/a?b=c' });
  });

  it('reads a valueless key as empty rather than dropping it', () => {
    expect(parseQueryString('debug')).toEqual({ debug: '' });
  });

  it('takes the last value of a repeated key, as a browser does', () => {
    expect(parseQueryString('utm_term=a&utm_term=b')).toEqual({ utm_term: 'b' });
  });

  it('skips a malformed escape rather than failing the whole request', () => {
    expect(parseQueryString('bad=%E0%A4%A&utm_source=google')).toEqual({ utm_source: 'google' });
  });

  it('answers empty for an empty query string', () => {
    expect(parseQueryString('')).toEqual({});
  });

  it('ignores stray ampersands', () => {
    expect(parseQueryString('&&utm_source=google&&')).toEqual({ utm_source: 'google' });
  });
});

describe('createCampaignRouteHandler', () => {
  it('rewrites the uri for a matching ad click', async () => {
    const handler = createCampaignRouteHandler(source());
    const result = await handler(
      viewerRequest('/product/analytics', 'utm_term=enterprise+plan')
    );
    expect(result.uri).toBe('/product/analytics-enterprise-plan');
  });

  it('leaves the query string intact, so the campaign page still sees the campaign', async () => {
    const handler = createCampaignRouteHandler(source());
    const result = await handler(
      viewerRequest('/product/analytics', 'utm_term=enterprise+plan&gclid=Cj0KCQ')
    );
    expect(result.querystring).toBe('utm_term=enterprise+plan&gclid=Cj0KCQ');
  });

  it('returns the request rather than a redirect response', async () => {
    // A 302 would change the address bar, dropping the campaign parameters the
    // customer's analytics reads and showing a URL the ad did not promise.
    const handler = createCampaignRouteHandler(source());
    const result = await handler(
      viewerRequest('/product/analytics', 'utm_term=enterprise+plan')
    );
    expect(result).not.toHaveProperty('status');
    expect(result).toHaveProperty('uri');
  });

  it('leaves organic traffic untouched', async () => {
    const handler = createCampaignRouteHandler(source());
    const result = await handler(viewerRequest('/product/analytics', ''));
    expect(result.uri).toBe('/product/analytics');
  });

  it('does not touch the rule source for a request with no query string', async () => {
    const getRoutes = jest.fn(async () => ROUTES);
    const handler = createCampaignRouteHandler({ getRoutes });
    await handler(viewerRequest('/pricing', ''));
    expect(getRoutes).not.toHaveBeenCalled();
  });

  it('leaves an untested keyword untouched', async () => {
    const handler = createCampaignRouteHandler(source());
    const result = await handler(viewerRequest('/product/analytics', 'utm_term=student+discount'));
    expect(result.uri).toBe('/product/analytics');
  });

  it('serves the requested page when the rule source throws', async () => {
    // An edge function that can throw is one that can 503 a marketing site.
    const handler = createCampaignRouteHandler({
      getRoutes: async () => {
        throw new Error('Contentful is down');
      }
    });
    const result = await handler(
      viewerRequest('/product/analytics', 'utm_term=enterprise+plan')
    );
    expect(result.uri).toBe('/product/analytics');
  });

  it.each([
    ['an absolute URL', 'https://evil.example/landing'],
    ['a protocol-relative URL', '//evil.example/landing'],
    ['a query string CloudFront cannot hold in a uri', '/landing?x=1']
  ])('never writes %s into request.uri', async (_label, targetPath) => {
    const hostile = [
      { basePath: '/product/analytics', matchParams: { utm_term: 'enterprise plan' }, targetPath }
    ];
    const handler = createCampaignRouteHandler(source(hostile));
    const result = await handler(
      viewerRequest('/product/analytics', 'utm_term=enterprise+plan')
    );
    expect(result.uri).toBe('/product/analytics');
  });

  it('survives an event shape it did not expect, without inventing a rewrite', async () => {
    // `toHaveProperty('uri')` alone is satisfied by anything at all. What is
    // worth pinning is that it does not throw (a throw is a 502 with no
    // inspectable value) and does not route the request somewhere.
    const handler = createCampaignRouteHandler(source());
    for (const event of [{ Records: [] }, { Records: [{}] }, {}, undefined]) {
      const result = await handler(event as unknown as CloudFrontEvent);
      expect(result.uri).toBe('/');
      expect(result.querystring).toBe('');
    }
  });

  it('honours pageExists, so an unpublished campaign page is not rewritten to', async () => {
    const handler = createCampaignRouteHandler(source(), { pageExists: () => false });
    const result = await handler(
      viewerRequest('/product/analytics', 'utm_term=enterprise+plan')
    );
    expect(result.uri).toBe('/product/analytics');
  });

  it('preserves the other fields CloudFront put on the request', async () => {
    // The handler returns the same object it was given, so headers, method and
    // everything else downstream depends on have to survive the rewrite.
    const event = viewerRequest('/product/analytics', 'utm_term=enterprise+plan');
    event.Records[0]!.cf.request.headers = { host: [{ key: 'Host', value: 'example.com' }] };
    const handler = createCampaignRouteHandler(source());
    const result = await handler(event);
    expect(result.headers).toEqual({ host: [{ key: 'Host', value: 'example.com' }] });
  });
});

describe('a source that knows which pages exist', () => {
  // The Next adapter has always consulted `source.pageExists`; this one passed
  // its options straight through and never looked. So a source that CAN answer
  // — the endpoint one does, because it sees the route list beside the rules —
  // had that answer honoured on Next.js and ignored on CloudFront. A customer
  // running both across one site has to get the same answer from each.
  const sourceKnowing = (exists: boolean) => ({
    getRoutes: async () => ROUTES,
    pageExists: () => exists
  });

  it('does not rewrite to a page the source says is not there', async () => {
    const event = viewerRequest('/product/analytics', 'utm_term=enterprise+plan');
    const result = await createCampaignRouteHandler(sourceKnowing(false))(event);
    expect(result.uri).toBe('/product/analytics');
  });

  it('rewrites when the source says the page is there', async () => {
    const event = viewerRequest('/product/analytics', 'utm_term=enterprise+plan');
    const result = await createCampaignRouteHandler(sourceKnowing(true))(event);
    expect(result.uri).toBe('/product/analytics-enterprise-plan');
  });

  it('lets the caller overrule the source', async () => {
    // Same precedence as the Next adapter: an explicit option wins, so a
    // customer who knows better than their own source can say so.
    const event = viewerRequest('/product/analytics', 'utm_term=enterprise+plan');
    const handler = createCampaignRouteHandler(sourceKnowing(false), { pageExists: () => true });
    expect((await handler(event)).uri).toBe('/product/analytics-enterprise-plan');
  });
});
