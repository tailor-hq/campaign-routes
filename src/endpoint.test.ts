import {
  campaignRoutesPayload,
  createEndpointRouteSource,
  isLoopbackOrigin,
  isRefusedRequestOrigin,
  requestOriginPolicy
} from './endpoint.js';

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

  it('survives a caller with nothing to report, and leaves paths out rather than inventing an empty one', () => {
    expect(campaignRoutesPayload(undefined as never, undefined)).toEqual({ routes: [] });
    expect(campaignRoutesPayload([], [])).toEqual({ routes: [], paths: [] });
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

  it('refuses every candidate once the endpoint has said the site serves no pages', async () => {
    // `[]` is not "unknown". The payload carries `paths` whenever the route
    // handler supplied one, so an empty list is the endpoint's explicit
    // statement that nothing exists — a page query that failed into an empty
    // array, a deploy that has not published yet. Reading it as unknown
    // switched the 404 guard off exactly when the inventory was most likely
    // wrong, and rewrote paid traffic to pages that were not there.
    const source = createEndpointRouteSource({
      fetchImpl: respondWith({ routes: [ROUTE], paths: [] })
    });
    await source.getRoutes('https://site.test');
    expect(source.pageExists('/pricing-enterprise')).toBe(false);
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

  it('never lets a request origin override a pinned one', async () => {
    // The request origin is the Host header, and behind a forwarding proxy or
    // on self-hosted Next.js that header is attacker-supplied. A customer who
    // pins `origin` is opting out of trusting it, and the pin has to hold on
    // every call — including one that hands in a different origin — or the
    // option is decoration and the SSRF it exists to close is still open.
    const fetchImpl = respondWith({ routes: [ROUTE], paths: [] });
    const source = createEndpointRouteSource({
      origin: 'https://www.example.com',
      ttlMs: 0,
      fetchImpl
    });

    await source.getRoutes('https://evil.example');
    await source.getRoutes('https://also-evil.example');

    const calls = (fetchImpl as unknown as jest.Mock).mock.calls;
    expect(calls.map((call) => call[0])).toEqual([
      'https://www.example.com/api/campaign-routes',
      'https://www.example.com/api/campaign-routes'
    ]);
  });

  it('freezes each rule to the leaf, so an onMatch cannot change routing for the next visitor', async () => {
    // The outer array being frozen is not enough: a consumer's onMatch that
    // "normalizes" matchParams in place would rewrite the rule for every
    // request on this isolate for as long as the cache lives.
    const fetchImpl = respondWith({ routes: [ROUTE], paths: [] });
    const source = createEndpointRouteSource({ fetchImpl });
    const [first] = await source.getRoutes('https://www.example.com');
    expect(() => {
      (first as { targetPath: string }).targetPath = '/elsewhere';
    }).toThrow();
    expect(() => {
      (first!.matchParams as Record<string, string>).utm_campaign = 'changed';
    }).toThrow();
    const [again] = await source.getRoutes('https://www.example.com');
    expect(again).toEqual(ROUTE);
  });

  it('stops serving stale rules once an outage outlives maxStaleMs, and tells onError along the way', async () => {
    let now = 1_000_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    let failing = false;
    const fetchImpl = jest.fn(async () => {
      if (failing) throw new Error('endpoint down');
      return { ok: true, status: 200, json: async () => ({ routes: [ROUTE], paths: [] }) };
    }) as unknown as typeof fetch;
    const onError = jest.fn();
    const source = createEndpointRouteSource({ fetchImpl, onError, ttlMs: 1_000, maxStaleMs: 5_000 });

    expect(await source.getRoutes('https://site.test')).toEqual([ROUTE]);
    failing = true;
    now += 1_001;
    expect(await source.getRoutes('https://site.test')).toEqual([ROUTE]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String((onError.mock.calls[0] as unknown[])[0])).toContain('endpoint down');

    now += 5_000;
    expect(await source.getRoutes('https://site.test')).toEqual([]);
    clock.mockRestore();
  });

  it('hands every caller the same frozen rules, so nobody can corrupt the cache', async () => {
    // Every request on the isolate gets these arrays by reference, and the
    // callers are the customer's own code. The Contentful source freezes for
    // this reason; this one has to as well or the two sources differ on the
    // one property that decides whether a helper sorting in place breaks the
    // site.
    const source = createEndpointRouteSource({
      fetchImpl: respondWith({ routes: [ROUTE], paths: ['/pricing-enterprise'] })
    });

    const routes = await source.getRoutes('https://site.test');
    expect(Object.isFrozen(routes)).toBe(true);
    expect(() => {
      routes.push(ROUTE);
    }).toThrow();
  });

  it("keeps each origin's rules apart, so one hostname never answers for another", async () => {
    // A deployment routinely serves more than one hostname — production, a
    // preview alias, a branch URL. One shared cache meant whichever origin
    // loaded first answered for all of them, routes and page list alike.
    const fetchImpl = jest.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.startsWith('https://a.example')
          ? { routes: [ROUTE], paths: ['/pricing-enterprise'] }
          : { routes: [], paths: ['/somewhere-else'] }
    })) as unknown as typeof fetch;
    const source = createEndpointRouteSource({ fetchImpl });

    expect(await source.getRoutes('https://a.example')).toEqual([ROUTE]);
    expect(await source.getRoutes('https://b.example')).toEqual([]);
    expect(source.pageExists('/pricing-enterprise', 'https://a.example')).toBe(true);
    expect(source.pageExists('/pricing-enterprise', 'https://b.example')).toBe(false);
  });

  it("lets a spoofed Host poison only its own cache, never a real visitor's", async () => {
    // The request origin is the Host header, and behind a forwarding proxy that
    // is attacker-supplied. The rules fetched for a bogus Host must reach only
    // requests carrying that same bogus Host — the attacker's own.
    const fetchImpl = jest.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.startsWith('https://evil.example')
          ? { routes: [{ ...ROUTE, targetPath: '/attacker-picked' }], paths: [] }
          : { routes: [ROUTE], paths: [] }
    })) as unknown as typeof fetch;
    const source = createEndpointRouteSource({ fetchImpl });

    await source.getRoutes('https://evil.example');
    expect(await source.getRoutes('https://www.example.com')).toEqual([ROUTE]);
  });

  it('bounds how many origins it remembers, so random Hosts cannot grow it forever', async () => {
    const fetchImpl = respondWith({ routes: [ROUTE], paths: [] });
    const source = createEndpointRouteSource({ fetchImpl });
    for (let index = 0; index < 20; index += 1) {
      await source.getRoutes(`https://host-${index}.example`);
    }
    // The first origin fell out of the map, so asking for it again inside the
    // TTL is a fresh fetch rather than a cache hit.
    const before = (fetchImpl as unknown as jest.Mock).mock.calls.length;
    await source.getRoutes('https://host-0.example');
    expect((fetchImpl as unknown as jest.Mock).mock.calls.length).toBe(before + 1);
  });

  describe('a request origin only a server could reach', () => {
    // Every refusal below warns once; the warning is asserted on elsewhere.
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
    });

    // A forged Host header can name anything, and the fetch this source makes
    // from it runs inside the customer's network. The path is fixed and the
    // body never goes back to the requester, so the primitive is blind — but a
    // blind GET to a cloud metadata service or a private address is still a
    // request the customer never meant to make. Each of these must produce no
    // fetch at all, and no other origin's rules in its place.
    const refused = [
      'http://169.254.169.254',
      'http://[fe80::1]',
      'http://10.0.0.5',
      'http://172.16.0.1',
      'http://192.168.1.1',
      'http://100.100.100.200',
      'http://0.0.0.0',
      'http://[::ffff:10.0.0.5]',
      'http://[fd00::1]',
      'http://user:secret@www.example.com',
      'ftp://www.example.com'
    ];

    for (const origin of refused) {
      it(`refuses ${origin}`, async () => {
        const fetchImpl = respondWith({ routes: [ROUTE], paths: [] });
        const source = createEndpointRouteSource({ fetchImpl });
        await source.getRoutes('https://www.example.com');
        expect(await source.getRoutes(origin)).toEqual([]);
        expect((fetchImpl as unknown as jest.Mock).mock.calls.map((call) => call[0])).toEqual([
          'https://www.example.com/api/campaign-routes'
        ]);
        expect(isRefusedRequestOrigin(origin)).toBe(true);
      });
    }

    it('still reads from localhost, because that is where next dev runs', async () => {
      // Refusing loopback breaks every developer's first run of the package,
      // and a request to a server's own loopback reaches only what that server
      // already exposes to itself. A production self-host closes it with
      // `origin` or `trustedOrigins`.
      const fetchImpl = respondWith({ routes: [ROUTE], paths: [] });
      const source = createEndpointRouteSource({ fetchImpl });
      expect(await source.getRoutes('http://localhost:3000')).toEqual([ROUTE]);
      expect(isRefusedRequestOrigin('http://localhost:3000')).toBe(false);
    });

    it('never applies the check to a pinned origin, which is trusted as configured', async () => {
      const fetchImpl = respondWith({ routes: [ROUTE], paths: [] });
      const source = createEndpointRouteSource({ origin: 'http://10.0.0.5:8080', fetchImpl });
      expect(await source.getRoutes('https://www.example.com')).toEqual([ROUTE]);
      expect((fetchImpl as unknown as jest.Mock).mock.calls[0][0]).toBe(
        'http://10.0.0.5:8080/api/campaign-routes'
      );
    });
  });

  it('reads only from trustedOrigins when they are given', async () => {
    const fetchImpl = respondWith({ routes: [ROUTE], paths: [] });
    const source = createEndpointRouteSource({
      trustedOrigins: ['https://www.example.com', 'https://preview.example.com/'],
      fetchImpl
    });

    expect(await source.getRoutes('https://www.example.com')).toEqual([ROUTE]);
    expect(await source.getRoutes('https://preview.example.com')).toEqual([ROUTE]);
    // Public, well-formed, and not on the list: refused just the same.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await source.getRoutes('https://www.example.com.evil.example')).toEqual([]);
    warn.mockRestore();
    expect((fetchImpl as unknown as jest.Mock).mock.calls.map((call) => call[0])).toEqual([
      'https://www.example.com/api/campaign-routes',
      'https://preview.example.com/api/campaign-routes'
    ]);
  });

  describe('how far a request origin is trusted depends on where the code runs', () => {
    const keys = ['VERCEL', 'NETLIFY', 'NODE_ENV'] as const;
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      for (const key of keys) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    });
    afterEach(() => {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    it('is decided from the environment, and says so', () => {
      expect(requestOriginPolicy({ VERCEL: '1', NODE_ENV: 'production' })).toBe('platform');
      expect(requestOriginPolicy({ NETLIFY: 'true', NODE_ENV: 'production' })).toBe('platform');
      expect(requestOriginPolicy({ NODE_ENV: 'development' })).toBe('development');
      expect(requestOriginPolicy({})).toBe('development');
      expect(requestOriginPolicy({ NODE_ENV: 'production' })).toBe('refuse');
    });

    it('in production off a hostname-routing platform, reads nothing until configured — and says so once', async () => {
      // The fail-closed default a public package owes its users. A self-hosted
      // Next.js has nothing vouching for the Host header, so a request-derived
      // origin is refused outright. Silently switching every campaign off is
      // the failure this package exists to avoid, so it warns — once, since a
      // warning per request is a log nobody reads.
      process.env.NODE_ENV = 'production';
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchImpl = respondWith({ routes: [ROUTE], paths: [] });
      const source = createEndpointRouteSource({ fetchImpl });

      expect(await source.getRoutes('https://www.example.com')).toEqual([]);
      expect(await source.getRoutes('https://www.example.com')).toEqual([]);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('trustedOrigins');
      warn.mockRestore();
    });

    it('in production on Vercel, the platform vouches for Host: public origins read, loopback does not', async () => {
      process.env.NODE_ENV = 'production';
      process.env.VERCEL = '1';
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchImpl = respondWith({ routes: [ROUTE], paths: [] });
      const source = createEndpointRouteSource({ fetchImpl });

      expect(await source.getRoutes('https://www.example.com')).toEqual([ROUTE]);
      expect(await source.getRoutes('http://localhost:3000')).toEqual([]);
      expect(isLoopbackOrigin('http://localhost:3000')).toBe(true);
      expect(isLoopbackOrigin('http://[::1]:3000')).toBe(true);
      expect(isLoopbackOrigin('https://www.example.com')).toBe(false);
      warn.mockRestore();
    });

    it('trustedOrigins still wins over every policy', async () => {
      process.env.NODE_ENV = 'production';
      const fetchImpl = respondWith({ routes: [ROUTE], paths: [] });
      const source = createEndpointRouteSource({ trustedOrigins: ['https://www.example.com'], fetchImpl });
      expect(await source.getRoutes('https://www.example.com')).toEqual([ROUTE]);
    });
  });

  it('bounds the reads in flight, so a burst of new origins cannot fan out into a burst of requests', async () => {
    // The cache size bounds what is remembered, not what is fetched: each new
    // origin starts a read before anything is evicted. Twelve origins arriving
    // at once must not become twelve concurrent server-side requests.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = jest.fn(async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ routes: [ROUTE], paths: [] }) };
    }) as unknown as typeof fetch;
    const source = createEndpointRouteSource({ fetchImpl });

    const reads = Array.from({ length: 12 }, (_, index) =>
      source.getRoutes(`https://host-${index}.example`)
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    release();
    const results = await Promise.all(reads);
    expect(results.filter((routes) => routes.length === 1)).toHaveLength(4);
    expect(results.filter((routes) => routes.length === 0)).toHaveLength(8);
  });
});
