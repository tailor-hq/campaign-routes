import { createContentfulRouteSource, toCampaignRoutes } from './contentful.js';
import type { CampaignRoute } from './core/index.js';

const entry = (fields: Record<string, unknown>) => ({ fields });

const localized = (value: unknown) => ({ 'en-US': value });

const ROUTE_FIELDS = {
  basePath: '/product/analytics',
  targetPath: '/product/analytics-enterprise-plan',
  matchParams: { utm_term: 'enterprise plan' }
};

/** A `fetch` stand-in that answers with a CDA-shaped body. */
const respondWith = (items: unknown[]) =>
  jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ items })
  })) as unknown as typeof fetch;

describe('toCampaignRoutes', () => {
  it('reads a plain, unlocalized entry', () => {
    expect(toCampaignRoutes([entry(ROUTE_FIELDS)], 'en-US')).toEqual([
      {
        basePath: '/product/analytics',
        targetPath: '/product/analytics-enterprise-plan',
        matchParams: { utm_term: 'enterprise plan' }
      }
    ]);
  });

  it('reads a localized entry, which is the shape a localized space returns', () => {
    const item = entry({
      basePath: localized(ROUTE_FIELDS.basePath),
      targetPath: localized(ROUTE_FIELDS.targetPath),
      matchParams: localized(ROUTE_FIELDS.matchParams)
    });
    expect(toCampaignRoutes([item], 'en-US')).toEqual([ROUTE_FIELDS]);
  });

  it('reads the requested locale rather than assuming en-US', () => {
    const item = entry({
      basePath: { 'de-DE': '/produkt' },
      targetPath: { 'de-DE': '/produkt-kampagne' },
      matchParams: { 'de-DE': { utm_term: 'beobachtbarkeit' } }
    });
    expect(toCampaignRoutes([item], 'de-DE')).toEqual([
      { basePath: '/produkt', targetPath: '/produkt-kampagne', matchParams: { utm_term: 'beobachtbarkeit' } }
    ]);
  });

  it('drops a half-filled entry without taking the usable ones with it', () => {
    // The entries come from a CMS a person edits mid-campaign, so a rule with
    // the target still blank is an ordinary state rather than an exception.
    const items = [
      entry({ basePath: '/a', matchParams: { utm_term: 'x' } }),
      entry(ROUTE_FIELDS)
    ];
    expect(toCampaignRoutes(items, 'en-US')).toEqual([ROUTE_FIELDS]);
  });

  it('drops an entry whose matchParams is empty, so it can never match all traffic', () => {
    const items = [entry({ basePath: '/a', targetPath: '/b', matchParams: {} })];
    expect(toCampaignRoutes(items, 'en-US')).toEqual([]);
  });

  it('drops non-string param values instead of coercing them', () => {
    // A number typed into the JSON field is a content mistake. Coercing it would
    // make `utm_term: 2026` match `?utm_term=2026`, which nobody asked for.
    const items = [
      entry({ basePath: '/a', targetPath: '/b', matchParams: { utm_term: 'x', page: 2 } })
    ];
    expect(toCampaignRoutes(items, 'en-US')).toEqual([
      { basePath: '/a', targetPath: '/b', matchParams: { utm_term: 'x' } }
    ]);
  });

  it('survives entries with no fields at all', () => {
    expect(toCampaignRoutes([{}, entry(ROUTE_FIELDS)], 'en-US')).toEqual([ROUTE_FIELDS]);
  });

  it('rejects an array matchParams, which JSON allows and the core cannot use', () => {
    const items = [entry({ basePath: '/a', targetPath: '/b', matchParams: ['utm_term'] })];
    expect(toCampaignRoutes(items, 'en-US')).toEqual([]);
  });
});

describe('createContentfulRouteSource', () => {
  it('asks the Delivery API for published tailorCampaignRoute entries', async () => {
    const fetchImpl = respondWith([entry(ROUTE_FIELDS)]);
    const source = createContentfulRouteSource({
      spaceId: 'zl46wx7qt94g',
      deliveryToken: 'cda-token',
      fetchImpl
    });

    await source.getRoutes();

    const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0];
    expect(url).toContain('https://cdn.contentful.com/spaces/zl46wx7qt94g/environments/master/entries');
    expect(url).toContain('content_type=tailorCampaignRoute');
    expect(init.headers.Authorization).toBe('Bearer cda-token');
  });

  it('can be pointed at the Preview API, which is the only way to see a draft rule', async () => {
    const fetchImpl = respondWith([]);
    const source = createContentfulRouteSource({
      spaceId: 'space',
      deliveryToken: 'preview-token',
      host: 'preview.contentful.com',
      fetchImpl
    });
    await source.getRoutes();
    expect((fetchImpl as unknown as jest.Mock).mock.calls[0][0]).toContain(
      'https://preview.contentful.com/spaces/space/'
    );
  });

  it.each([
    'evil.example',
    'cdn.contentful.com@evil.example',
    'cdn.contentful.com/../',
    'CDN.CONTENTFUL.COM',
    ''
  ])('refuses to send the delivery token to "%s"', (host) => {
    // Every request carries `Authorization: Bearer <delivery token>`, so an
    // unvalidated host read from a deploy's config is a route for that token to
    // leave. It throws at CONSTRUCTION, where somebody is looking, rather than
    // failing open per request after the token has already gone.
    expect(() =>
      createContentfulRouteSource({ spaceId: 's', deliveryToken: 'secret', host })
    ).toThrow(/host must be one of/);
  });

  it('fetches every page rather than silently stopping at the first', async () => {
    // Contentful caps a page at 1000 and reports `total`. Reading only `items`
    // means that past 1000 rules some campaigns never route, with nothing
    // anywhere saying so.
    const page = (count: number, start: number) =>
      Array.from({ length: count }, (_unused, index) => ({
        fields: {
          basePath: `/p${start + index}`,
          targetPath: `/p${start + index}-x`,
          matchParams: { utm_term: 'x' }
        }
      }));

    const responses = [
      { items: page(1000, 0), total: 1500 },
      { items: page(500, 1000), total: 1500 }
    ];
    let call = 0;
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => responses[call++]
    })) as unknown as typeof fetch;

    const source = createContentfulRouteSource({ spaceId: 's', deliveryToken: 't', fetchImpl });
    expect(await source.getRoutes()).toHaveLength(1500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((fetchImpl as unknown as jest.Mock).mock.calls[1][0]).toContain('skip=1000');
  });

  it('stops on a short page even when total disagrees', async () => {
    // A wrong or ever-growing `total` must not turn into a loop that runs until
    // the deadline kills it — from the visitor's seat that is Contentful being
    // down, which is the outcome all of this exists to avoid.
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ items: [entry(ROUTE_FIELDS)], total: 999_999 })
    })) as unknown as typeof fetch;

    const source = createContentfulRouteSource({ spaceId: 's', deliveryToken: 't', fetchImpl });
    expect(await source.getRoutes()).toEqual([ROUTE_FIELDS]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('freezes each rule to the leaf, so an onMatch cannot change routing for the next visitor', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ items: [entry(ROUTE_FIELDS)] })
    })) as unknown as typeof fetch;
    const source = createContentfulRouteSource({ spaceId: 's', deliveryToken: 't', fetchImpl });
    const [first] = await source.getRoutes();
    expect(() => {
      (first as { targetPath: string }).targetPath = '/elsewhere';
    }).toThrow();
    expect(() => {
      (first!.matchParams as Record<string, string>).utm_campaign = 'changed';
    }).toThrow();
    const [again] = await source.getRoutes();
    expect(again).toEqual(ROUTE_FIELDS);
  });

  it('tells onError when a read fails, and never lets that callback throw into the request', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    const onError = jest.fn(() => {
      throw new Error('my logger is broken');
    });
    const source = createContentfulRouteSource({ spaceId: 's', deliveryToken: 't', fetchImpl, onError });
    expect(await source.getRoutes()).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0] as unknown[])[0]).toBeInstanceOf(Error);
  });

  it('copies and freezes a bootstrap, so the caller cannot change routing after the fact', async () => {
    const bootstrap: CampaignRoute[] = [{ ...ROUTE_FIELDS, matchParams: { ...ROUTE_FIELDS.matchParams } }];
    const fetchImpl = jest.fn(() => new Promise<never>(() => {})) as unknown as typeof fetch;
    const source = createContentfulRouteSource({ spaceId: 's', deliveryToken: 't', fetchImpl, bootstrap });

    const served = await source.getRoutes();
    expect(served).toEqual([ROUTE_FIELDS]);
    expect(Object.isFrozen(served[0])).toBe(true);
    expect(Object.isFrozen(bootstrap[0])).toBe(false);

    bootstrap[0]!.targetPath = '/elsewhere';
    expect(await source.getRoutes()).toEqual([ROUTE_FIELDS]);
  });

  it('ignores a bootstrap with nothing usable in it, rather than seeding "no campaigns"', async () => {
    // An empty or wholly malformed bootstrap cannot be told apart from "I had
    // nothing to ship", and seeding it would make the first request serve the
    // original page while looking configured. Nothing usable means none: the
    // first read blocks on Contentful as it would with no bootstrap at all.
    const fetchImpl = respondWith([entry(ROUTE_FIELDS)]);
    const source = createContentfulRouteSource({
      spaceId: 's',
      deliveryToken: 't',
      fetchImpl,
      bootstrap: [{ basePath: '/a', targetPath: '/b', matchParams: {} }]
    });
    expect(await source.getRoutes()).toEqual([ROUTE_FIELDS]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('hands out a frozen array, since every caller gets the same one', async () => {
    // The callers are code we do not control. A customer's helper sorting this
    // in place would corrupt every later request on that isolate.
    const source = createContentfulRouteSource({
      spaceId: 's',
      deliveryToken: 't',
      fetchImpl: respondWith([entry(ROUTE_FIELDS)])
    });
    const routes = await source.getRoutes();
    expect(Object.isFrozen(routes)).toBe(true);
  });

  it('serves the cache at the exact TTL boundary and refetches past it', async () => {
    const fetchImpl = respondWith([entry(ROUTE_FIELDS)]);
    const source = createContentfulRouteSource({
      spaceId: 's',
      deliveryToken: 't',
      ttlMs: 1_000,
      fetchImpl
    });

    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    await source.getRoutes();
    // `now - cachedAt < ttlMs`, so exactly ttlMs is a MISS.
    jest.spyOn(Date, 'now').mockReturnValue(now + 999);
    await source.getRoutes();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    jest.spyOn(Date, 'now').mockReturnValue(now + 1_000);
    await source.getRoutes();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    jest.spyOn(Date, 'now').mockRestore();
  });

  it('refetches on every call at ttlMs 0', async () => {
    const fetchImpl = respondWith([entry(ROUTE_FIELDS)]);
    const source = createContentfulRouteSource({
      spaceId: 's',
      deliveryToken: 't',
      ttlMs: 0,
      fetchImpl
    });
    await source.getRoutes();
    await source.getRoutes();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('uses the environment it was given', async () => {
    const fetchImpl = respondWith([]);
    const source = createContentfulRouteSource({
      spaceId: 'space',
      environmentId: 'staging',
      deliveryToken: 't',
      fetchImpl
    });
    await source.getRoutes();
    expect((fetchImpl as unknown as jest.Mock).mock.calls[0][0]).toContain('/environments/staging/');
  });

  it('serves the cache within the TTL rather than refetching per request', async () => {
    const fetchImpl = respondWith([entry(ROUTE_FIELDS)]);
    const source = createContentfulRouteSource({
      spaceId: 'space',
      deliveryToken: 't',
      ttlMs: 60_000,
      fetchImpl
    });

    await source.getRoutes();
    await source.getRoutes();
    await source.getRoutes();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refetches once the TTL has passed', async () => {
    const fetchImpl = respondWith([entry(ROUTE_FIELDS)]);
    const source = createContentfulRouteSource({
      spaceId: 'space',
      deliveryToken: 't',
      ttlMs: 50,
      fetchImpl
    });

    await source.getRoutes();
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 5_000);
    await source.getRoutes();
    jest.spyOn(Date, 'now').mockRestore();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('makes one request for a burst of concurrent callers', async () => {
    // Without this, every request in flight when the cache expires starts its
    // own fetch — a thundering herd aimed at the customer's own rate-limited
    // Contentful, caused by us.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = jest.fn(async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ items: [entry(ROUTE_FIELDS)] }) };
    }) as unknown as typeof fetch;

    const source = createContentfulRouteSource({ spaceId: 's', deliveryToken: 't', fetchImpl });
    const all = Promise.all([source.getRoutes(), source.getRoutes(), source.getRoutes()]);
    (release as unknown as () => void)();
    const results = await all;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual([ROUTE_FIELDS]);
    expect(results[2]).toEqual([ROUTE_FIELDS]);
  });

  it('answers with the last good rules when Contentful fails', async () => {
    // Serving stale rules through an outage is the safer half of the trade: the
    // alternative is a Contentful blip silently switching every campaign off.
    let ok = true;
    const fetchImpl = jest.fn(async () => {
      if (!ok) throw new Error('network');
      return { ok: true, status: 200, json: async () => ({ items: [entry(ROUTE_FIELDS)] }) };
    }) as unknown as typeof fetch;

    const source = createContentfulRouteSource({
      spaceId: 's',
      deliveryToken: 't',
      ttlMs: 0,
      fetchImpl
    });

    expect(await source.getRoutes()).toEqual([ROUTE_FIELDS]);
    ok = false;
    expect(await source.getRoutes()).toEqual([ROUTE_FIELDS]);
  });

  it('abandons a fetch that stalls, so failing open actually fails open', async () => {
    // Without the deadline this test hangs rather than failing, which is the
    // whole point: fail-open needs the promise to SETTLE. A stalled connection
    // never rejects, so the adapter's catch block is never reached, and
    // Lambda@Edge kills the invocation before JavaScript regains control.
    const fetchImpl = jest.fn(
      (_url: unknown, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    ) as unknown as typeof fetch;

    const source = createContentfulRouteSource({
      spaceId: 's',
      deliveryToken: 't',
      timeoutMs: 40,
      fetchImpl
    });

    await expect(source.getRoutes()).resolves.toEqual([]);
  });

  it('keeps the last good rules when a later fetch stalls', async () => {
    let stall = false;
    const fetchImpl = jest.fn((_url: unknown, init: { signal: AbortSignal }) => {
      if (stall) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ items: [entry(ROUTE_FIELDS)] })
      });
    }) as unknown as typeof fetch;

    const source = createContentfulRouteSource({
      spaceId: 's',
      deliveryToken: 't',
      ttlMs: 0,
      timeoutMs: 40,
      fetchImpl
    });

    expect(await source.getRoutes()).toEqual([ROUTE_FIELDS]);
    stall = true;
    expect(await source.getRoutes()).toEqual([ROUTE_FIELDS]);
  });

  it('passes an abort signal on every request', async () => {
    const fetchImpl = respondWith([]);
    const source = createContentfulRouteSource({ spaceId: 's', deliveryToken: 't', fetchImpl });
    await source.getRoutes();
    expect((fetchImpl as unknown as jest.Mock).mock.calls[0][1].signal).toBeDefined();
  });

  it('answers with no rules, rather than throwing, when the first fetch ever fails', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    const source = createContentfulRouteSource({ spaceId: 's', deliveryToken: 't', fetchImpl });
    await expect(source.getRoutes()).resolves.toEqual([]);
  });

  it('treats a non-2xx as a failure rather than parsing the error body', async () => {
    // A 401 from a wrong token returns JSON with no `items`, which would
    // otherwise cache an empty rule set as if it were the truth.
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ message: 'The access token you sent could not be found' })
    })) as unknown as typeof fetch;
    const source = createContentfulRouteSource({ spaceId: 's', deliveryToken: 'bad', fetchImpl });
    await expect(source.getRoutes()).resolves.toEqual([]);
  });

  it('retries after a failure instead of caching the failure', async () => {
    let attempt = 0;
    const fetchImpl = jest.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('network');
      return { ok: true, status: 200, json: async () => ({ items: [entry(ROUTE_FIELDS)] }) };
    }) as unknown as typeof fetch;

    // A failure is remembered for a short, growing wait — never for the TTL.
    let now = 1_000_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const source = createContentfulRouteSource({ spaceId: 's', deliveryToken: 't', fetchImpl });
    expect(await source.getRoutes()).toEqual([]);
    now += 1_000;
    expect(await source.getRoutes()).toEqual([ROUTE_FIELDS]);
    clock.mockRestore();
  });
});
