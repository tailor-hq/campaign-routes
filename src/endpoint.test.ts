import { campaignRoutesPayload, createEndpointRouteSource } from './endpoint.js';

const ROUTE = {
  basePath: '/pricing',
  matchParams: { utm_campaign: 'enterprise' },
  targetPath: '/pricing-enterprise'
};

const respondWith = (body: unknown, ok = true) =>
  jest.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch;

describe('campaignRoutesPayload', () => {
  it('builds the shape both halves of the install agree on', () => {
    expect(campaignRoutesPayload([ROUTE], ['/pricing'])).toEqual({
      routes: [ROUTE],
      paths: ['/pricing']
    });
  });

  it('survives a caller with nothing to report', () => {
    expect(
      campaignRoutesPayload(undefined as never, undefined as never)
    ).toEqual({ routes: [], paths: [] });
  });
});

describe('createEndpointRouteSource', () => {
  it('reads the default path on the origin it is given', async () => {
    const fetchImpl = respondWith({ routes: [ROUTE], paths: ['/pricing-enterprise'] });
    const source = createEndpointRouteSource({ fetchImpl });

    expect(await source.getRoutes('https://example.com')).toEqual([ROUTE]);
    expect((fetchImpl as unknown as jest.Mock).mock.calls[0][0]).toBe(
      'https://example.com/api/campaign-routes'
    );
  });

  it('follows the request origin, so a preview deploy needs no configuration', async () => {
    // The whole reason the path is relative: a branch URL, a preview deploy and
    // production all work without an environment variable per environment.
    const fetchImpl = respondWith({ routes: [ROUTE], paths: [] });
    const source = createEndpointRouteSource({ ttlMs: 0, fetchImpl });

    await source.getRoutes('https://example.com');
    await source.getRoutes('https://preview.example.com');

    const calls = (fetchImpl as unknown as jest.Mock).mock.calls;
    expect(calls[0][0]).toContain('https://example.com/');
    expect(calls[1][0]).toContain('https://preview.example.com/');
  });

  it('takes a custom path', async () => {
    const fetchImpl = respondWith({ routes: [], paths: [] });
    const source = createEndpointRouteSource({ path: '/_tailor/rules', fetchImpl });
    await source.getRoutes('https://site.test');
    expect((fetchImpl as unknown as jest.Mock).mock.calls[0][0]).toBe('https://site.test/_tailor/rules');
  });

  it('answers pageExists from the payload the endpoint returned', async () => {
    const source = createEndpointRouteSource({
      fetchImpl: respondWith({ routes: [ROUTE], paths: ['/pricing', '/pricing-enterprise'] })
    });
    await source.getRoutes('https://site.test');

    expect(source.pageExists('/pricing-enterprise')).toBe(true);
    expect(source.pageExists('/pricing-black-friday')).toBe(false);
  });

  it('ignores trailing slash and case when checking a path', async () => {
    const source = createEndpointRouteSource({
      fetchImpl: respondWith({ routes: [], paths: ['/Pricing-Enterprise/'] })
    });
    await source.getRoutes('https://site.test');
    expect(source.pageExists('/pricing-enterprise')).toBe(true);
  });

  it('answers true before anything has loaded, rather than refusing every rule', async () => {
    // Not-yet-known and known-absent are different states, and only the second
    // is evidence. Refusing on a cold isolate would make the first request after
    // every deploy silently un-personalized.
    const source = createEndpointRouteSource({ fetchImpl: respondWith({ routes: [], paths: [] }) });
    expect(source.pageExists('/anything')).toBe(true);
  });

  it('answers true when the endpoint returned no path list at all', async () => {
    // An install that has not wired the paths half yet still routes campaigns.
    const source = createEndpointRouteSource({
      fetchImpl: respondWith({ routes: [ROUTE] })
    });
    await source.getRoutes('https://site.test');
    expect(source.pageExists('/whatever')).toBe(true);
  });

  it('serves no rules, rather than throwing, when the endpoint is down', async () => {
    const source = createEndpointRouteSource({ fetchImpl: respondWith({}, false) });
    await expect(source.getRoutes('https://site.test')).resolves.toEqual([]);
  });

  it('keeps the last good rules when the endpoint later fails', async () => {
    let ok = true;
    const fetchImpl = jest.fn(async () => ({
      ok,
      status: ok ? 200 : 502,
      json: async () => (ok ? { routes: [ROUTE], paths: ['/pricing-enterprise'] } : {})
    })) as unknown as typeof fetch;

    const source = createEndpointRouteSource({ ttlMs: 0, fetchImpl });
    expect(await source.getRoutes('https://site.test')).toEqual([ROUTE]);
    ok = false;
    expect(await source.getRoutes('https://site.test')).toEqual([ROUTE]);
    expect(source.pageExists('/pricing-enterprise')).toBe(true);
  });

  it('refuses a payload of the wrong shape rather than caching nonsense', async () => {
    // An endpoint returning an HTML error page, or a route handler somebody
    // changed, must not read as "there are no campaigns".
    const source = createEndpointRouteSource({ fetchImpl: respondWith({ items: [] }) });
    await expect(source.getRoutes('https://site.test')).resolves.toEqual([]);
  });

  it('serves the cache within the TTL', async () => {
    const fetchImpl = respondWith({ routes: [ROUTE], paths: [] });
    const source = createEndpointRouteSource({ ttlMs: 60_000, fetchImpl });
    await source.getRoutes('https://site.test');
    await source.getRoutes('https://site.test');
    await source.getRoutes('https://site.test');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('makes one request for a burst of concurrent callers', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = jest.fn(async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ routes: [ROUTE], paths: [] }) };
    }) as unknown as typeof fetch;

    const source = createEndpointRouteSource({ fetchImpl });
    const all = Promise.all([
      source.getRoutes('https://site.test'),
      source.getRoutes('https://site.test'),
      source.getRoutes('https://site.test')
    ]);
    (release as unknown as () => void)();
    const results = await all;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(results[2]).toEqual([ROUTE]);
  });

  it('abandons a fetch that stalls', async () => {
    const fetchImpl = jest.fn(
      (_url: unknown, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    ) as unknown as typeof fetch;

    const source = createEndpointRouteSource({ timeoutMs: 40, fetchImpl });
    await expect(source.getRoutes('https://site.test')).resolves.toEqual([]);
  });
});
