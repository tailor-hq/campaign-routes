import type { CampaignRoute } from './core/index.js';
import { campaignRouteFor } from './next.js';

const ROUTES: CampaignRoute[] = [
  {
    basePath: '/product/analytics',
    matchParams: { utm_term: 'enterprise plan' },
    targetPath: '/product/analytics-enterprise-plan'
  },
  {
    basePath: '/product/analytics',
    matchParams: { utm_term: 'nonprofit pricing' },
    targetPath: '/product/analytics-nonprofit-pricing'
  }
];

const source = (routes: CampaignRoute[] = ROUTES) => ({ getRoutes: async () => routes });

/** `NextRequest` is a `Request`, and `url` is all this reads off it. */
const request = (url: string) => ({ url });

describe('campaignRouteFor', () => {
  it('returns the campaign page for a matching ad click', async () => {
    const target = await campaignRouteFor(
      request('https://example.com/product/analytics?utm_term=enterprise%20plan'),
      source()
    );
    expect(target).toBe('/product/analytics-enterprise-plan');
  });

  it('reads a plus-encoded value, which is what Google actually sends', async () => {
    const target = await campaignRouteFor(
      request('https://example.com/product/analytics?utm_term=enterprise+plan'),
      source()
    );
    expect(target).toBe('/product/analytics-enterprise-plan');
  });

  it('leaves organic traffic alone', async () => {
    const target = await campaignRouteFor(
      request('https://example.com/product/analytics'),
      source()
    );
    expect(target).toBeNull();
  });

  it('makes no server-side request for a Host header naming an internal address', async () => {
    // The adapter hands the request's own origin to the source, and that origin
    // is the Host header. This is the whole chain end to end: a forged Host
    // naming a cloud metadata address must produce no fetch and no rewrite.
    const { createEndpointRouteSource } = await import('./endpoint.js');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ routes: ROUTES, paths: [] })
    })) as unknown as typeof fetch;
    const endpointSource = createEndpointRouteSource({ fetchImpl });

    const target = await campaignRouteFor(
      request('http://169.254.169.254/product/analytics?utm_term=enterprise+plan'),
      endpointSource
    );
    expect(target).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not touch the rule source for a request with no query string', async () => {
    // Organic traffic is the majority of a marketing site's requests. Answering
    // it before the fetch is what keeps the common case off the network.
    const getRoutes = jest.fn(async () => ROUTES);
    await campaignRouteFor(request('https://example.com/pricing'), { getRoutes });
    expect(getRoutes).not.toHaveBeenCalled();
  });

  it('leaves a keyword nobody has tested alone', async () => {
    const target = await campaignRouteFor(
      request('https://example.com/product/analytics?utm_term=student+discount'),
      source()
    );
    expect(target).toBeNull();
  });

  it('still matches when the ad platform appends its own click id', async () => {
    // The failure this guards is the one that passes every hand-typed test and
    // never fires in production: a real click carries gclid, fbclid and the
    // customer's own analytics parameters alongside the targeted one.
    const target = await campaignRouteFor(
      request(
        'https://example.com/product/analytics?utm_term=enterprise+plan&gclid=Cj0KCQ&utm_source=google'
      ),
      source()
    );
    expect(target).toBe('/product/analytics-enterprise-plan');
  });

  it.each([
    ['an absolute URL', 'https://evil.example/landing'],
    ['a protocol-relative URL', '//evil.example/landing'],
    ['a backslash', '/\\evil.example'],
    ['a tab URL parsing would strip', '/\t/evil.example']
  ])('never rewrites to %s, even when the CMS says so', async (_label, targetPath) => {
    // Asserting the good case does not contain "://" would pass against a
    // version with no validation at all, because the fixture has no "://" in
    // it. Feed it the hostile value instead.
    const hostile = [
      {
        basePath: '/product/analytics',
        matchParams: { utm_term: 'enterprise plan' },
        targetPath
      }
    ];
    const target = await campaignRouteFor(
      request('https://example.com/product/analytics?utm_term=enterprise+plan'),
      source(hostile)
    );
    expect(target).toBeNull();
  });

  it('resolves against the request origin and stays on it', async () => {
    // The documented middleware does exactly this, and it is only safe because
    // the core refuses anything but a rooted path.
    const target = await campaignRouteFor(
      request('https://example.com/product/analytics?utm_term=enterprise+plan'),
      source()
    );
    const resolved = new URL(target as string, 'https://example.com/product/analytics');
    expect(resolved.origin).toBe('https://example.com');
    expect(resolved.pathname).toBe('/product/analytics-enterprise-plan');
  });

  describe('the documented middleware snippet', () => {
    // The adapter was tested and the snippet was prose, so the one divergence
    // that existed between the two adapters lived exactly where nothing looked.
    // These assert what the CUSTOMER'S PAGE receives, which is the outcome.
    const AD_CLICK =
      'https://example.com/product/analytics?utm_source=google&utm_term=enterprise+plan&gclid=Cj0KCQ';

    it('carries the campaign parameters onto the campaign page', async () => {
      const target = await campaignRouteFor(request(AD_CLICK), source());
      // `nextUrl.clone()` in a real NextRequest; a URL built from the request is
      // the same object for this purpose.
      const url = new URL(AD_CLICK);
      url.pathname = target as string;

      expect(url.pathname).toBe('/product/analytics-enterprise-plan');
      expect(url.searchParams.get('utm_term')).toBe('enterprise plan');
      expect(url.searchParams.get('gclid')).toBe('Cj0KCQ');
      expect(url.origin).toBe('https://example.com');
    });

    it('would have lost them under `new URL(target, request.url)`', async () => {
      // Pinned as a counter-example so the snippet cannot quietly regress to the
      // shorter spelling: this is what that produces.
      const target = await campaignRouteFor(request(AD_CLICK), source());
      const wrong = new URL(target as string, AD_CLICK);
      expect(wrong.search).toBe('');
    });
  });

  it('uses the source own pageExists without being asked, when it has one', async () => {
    // The protection is on by default rather than something a customer has to
    // know to wire up — that is the whole reason the endpoint source carries it.
    const target = await campaignRouteFor(
      request('https://example.com/product/analytics?utm_term=enterprise+plan'),
      { getRoutes: () => ROUTES, pageExists: () => false }
    );
    expect(target).toBeNull();
  });

  it('lets the caller override the source own pageExists', async () => {
    const target = await campaignRouteFor(
      request('https://example.com/product/analytics?utm_term=enterprise+plan'),
      { getRoutes: () => ROUTES, pageExists: () => false },
      { pageExists: () => true }
    );
    expect(target).toBe('/product/analytics-enterprise-plan');
  });

  it('hands the request origin to the source', async () => {
    // A source reading an endpoint on this site needs it, and needs it per
    // request: a preview deploy serves a different origin than production.
    const getRoutes = jest.fn(() => ROUTES);
    await campaignRouteFor(
      request('https://preview.example.com/product/analytics?utm_term=x'),
      { getRoutes }
    );
    expect(getRoutes).toHaveBeenCalledWith('https://preview.example.com');
  });

  it('passes pageExists through, so an unpublished campaign page is skipped', async () => {
    const target = await campaignRouteFor(
      request('https://example.com/product/analytics?utm_term=enterprise+plan'),
      source(),
      { pageExists: () => false }
    );
    expect(target).toBeNull();
  });

  it('serves the page when the rule source is empty', async () => {
    const target = await campaignRouteFor(
      request('https://example.com/product/analytics?utm_term=enterprise+plan'),
      source([])
    );
    expect(target).toBeNull();
  });

  it('accepts a synchronous rule source', async () => {
    // A CloudFront KeyValueStore read and a bundled constant are both sync, and
    // a middleware should not have to wrap either in a promise to use this.
    const target = await campaignRouteFor(
      request('https://example.com/product/analytics?utm_term=enterprise+plan'),
      { getRoutes: () => ROUTES }
    );
    expect(target).toBe('/product/analytics-enterprise-plan');
  });

  it('serves the page when the rule source throws', async () => {
    // Nothing about campaign routing may cost a customer a page load — a middleware
    // that throws takes the whole route down, not just the personalization.
    const target = await campaignRouteFor(
      request('https://example.com/product/analytics?utm_term=enterprise+plan'),
      {
        getRoutes: async () => {
          throw new Error('Contentful is down');
        }
      }
    );
    expect(target).toBeNull();
  });

  it('serves the page when the request URL cannot be parsed', async () => {
    const target = await campaignRouteFor(request('not a url'), source());
    expect(target).toBeNull();
  });

  it('ignores a trailing slash, since the CMS field and the request disagree about it', async () => {
    const target = await campaignRouteFor(
      request('https://example.com/product/analytics/?utm_term=enterprise+plan'),
      source()
    );
    expect(target).toBe('/product/analytics-enterprise-plan');
  });
});
