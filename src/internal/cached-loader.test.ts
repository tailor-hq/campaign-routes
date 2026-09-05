import { createCachedLoader } from './cached-loader.js';

/** Let every already-queued microtask and the background refresh settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createCachedLoader', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('waits for the first load, because there is nothing else to serve', async () => {
    const load = jest.fn(async () => 'first');
    const loader = createCachedLoader({ ttlMs: 1_000, timeoutMs: 100, load });
    expect(await loader.read()).toBe('first');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('serves the cache within the TTL without loading again', async () => {
    const load = jest.fn(async () => 'v');
    const loader = createCachedLoader({ ttlMs: 60_000, timeoutMs: 100, load });
    await loader.read();
    await loader.read();
    await loader.read();
    expect(load).toHaveBeenCalledTimes(1);
  });

  describe('a failing upstream is left alone for a while', () => {
    it('does not retry on every read while the upstream is failing fast', async () => {
      // Contentful answering 429 in five milliseconds means the in-flight
      // collapse protects almost nothing: without a wait, every page request
      // becomes an upstream request against a service already refusing. One
      // failure starts a wait, and reads inside it answer with what is in
      // hand — here nothing — without touching the upstream.
      const load = jest.fn(async () => {
        throw new Error('429');
      });
      const loader = createCachedLoader({ ttlMs: 60_000, timeoutMs: 100, load });
      for (let i = 0; i < 20; i += 1) {
        expect(await loader.read()).toBeNull();
      }
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('retries once the wait is over, and the wait doubles per failure in a row', async () => {
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      const load = jest.fn(async () => {
        throw new Error('500');
      });
      const loader = createCachedLoader({ ttlMs: 60_000, timeoutMs: 100, load });

      await loader.read();
      expect(load).toHaveBeenCalledTimes(1);
      now += 999;
      await loader.read();
      expect(load).toHaveBeenCalledTimes(1);
      now += 1;
      await loader.read();
      expect(load).toHaveBeenCalledTimes(2);
      now += 1_999;
      await loader.read();
      expect(load).toHaveBeenCalledTimes(2);
      now += 1;
      await loader.read();
      expect(load).toHaveBeenCalledTimes(3);
    });

    it('keeps serving the last good value throughout, and a success ends the wait', async () => {
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      let failing = false;
      const load = jest.fn(async () => {
        if (failing) throw new Error('500');
        return 'good';
      });
      const loader = createCachedLoader({ ttlMs: 1_000, timeoutMs: 100, load });
      expect(await loader.read()).toBe('good');

      failing = true;
      now += 1_001;
      expect(await loader.read()).toBe('good');
      await settle();
      expect(load).toHaveBeenCalledTimes(2);
      expect(await loader.read()).toBe('good');
      expect(load).toHaveBeenCalledTimes(2);

      failing = false;
      now += 1_000;
      expect(await loader.read()).toBe('good');
      await settle();
      expect(load).toHaveBeenCalledTimes(3);
      now += 999;
      expect(await loader.read()).toBe('good');
      expect(load).toHaveBeenCalledTimes(3);
    });
  });

  describe('an outage is bounded', () => {
    it('serves the last good value through an outage, then nothing once it outlives maxStaleMs', async () => {
      // Availability against withdrawal. Serving last-good forever means a
      // campaign somebody unpublished to pull bad content stays live for as
      // long as the CMS is down, silently. Past the bound the caller serves
      // the page it was going to, which is this package's stated failure mode.
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      let failing = false;
      const load = jest.fn(async () => {
        if (failing) throw new Error('down');
        return 'good';
      });
      const loader = createCachedLoader({ ttlMs: 1_000, timeoutMs: 100, maxStaleMs: 10_000, load });
      expect(await loader.read()).toBe('good');

      failing = true;
      now += 9_000;
      expect(await loader.read()).toBe('good');
      await settle();
      now += 1_001;
      expect(await loader.read()).toBeNull();
      expect(loader.peek()).toBeNull();
      await settle();

      // Once a read succeeds again, the next request is personalized.
      failing = false;
      now += 30_000;
      expect(await loader.read()).toBeNull();
      await settle();
      expect(await loader.read()).toBe('good');
    });

    it('bounds an outage to one hour by default', async () => {
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      let failing = false;
      const load = jest.fn(async () => {
        if (failing) throw new Error('down');
        return 'good';
      });
      const loader = createCachedLoader({ ttlMs: 1_000, timeoutMs: 100, load });
      expect(await loader.read()).toBe('good');
      failing = true;
      now += 3_599_000;
      expect(await loader.read()).toBe('good');
      now += 1_001;
      expect(await loader.read()).toBeNull();
    });

    it('serves a bootstrap until the first real read lands, however long that takes', async () => {
      // The bootstrap is the floor, not a value that can go stale: with the
      // upstream down from the start there is nothing better to fall back to.
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      const load = jest.fn(async () => {
        throw new Error('down');
      });
      const loader = createCachedLoader({
        ttlMs: 1_000,
        timeoutMs: 100,
        maxStaleMs: 10_000,
        bootstrap: 'shipped',
        load
      });
      expect(await loader.read()).toBe('shipped');
      now += 100_000;
      expect(await loader.read()).toBe('shipped');
    });

    it('tells onError about each failed refresh, and survives the callback throwing', async () => {
      const onError = jest.fn(() => {
        throw new Error('logger broke');
      });
      const load = jest.fn(async () => {
        throw new Error('down');
      });
      const loader = createCachedLoader({ ttlMs: 1_000, timeoutMs: 100, load, onError });
      expect(await loader.read()).toBeNull();
      expect(onError).toHaveBeenCalledTimes(1);
      expect((onError.mock.calls[0] as unknown[])[0]).toEqual(new Error('down'));
    });
  });

  describe('stale-while-revalidate', () => {
    it('answers immediately with the stale value and refreshes behind it', async () => {
      // The whole point: after the first load, no request ever waits. Blocking
      // here made one visitor per TTL per isolate pay a full round trip for a
      // value the next visitor got free.
      let value = 'first';
      let releaseSecond: (() => void) | null = null;
      const secondStarted = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      const load = jest.fn(async () => {
        if (value === 'first') {
          value = 'second';
          return 'first';
        }
        (releaseSecond as unknown as () => void)();
        // Never settles within the assertion below, so a blocking read would
        // hang the test rather than quietly passing.
        return new Promise<string>(() => {});
      });

      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      const loader = createCachedLoader({ ttlMs: 100, timeoutMs: 50, load });
      expect(await loader.read()).toBe('first');

      jest.spyOn(Date, 'now').mockReturnValue(now + 1_000);
      expect(await loader.read()).toBe('first');
      await secondStarted;
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('serves the refreshed value once it lands', async () => {
      let n = 0;
      const load = jest.fn(async () => `v${(n += 1)}`);
      const loader = createCachedLoader({ ttlMs: 0, timeoutMs: 100, load });

      expect(await loader.read()).toBe('v1');
      expect(await loader.read()).toBe('v1'); // stale, refresh kicked off
      await settle();
      expect(await loader.read()).toBe('v2');
    });

    it('collapses concurrent background refreshes into one', async () => {
      const load = jest.fn(async () => 'v');
      const loader = createCachedLoader({ ttlMs: 0, timeoutMs: 100, load });
      await loader.read();

      await Promise.all([loader.read(), loader.read(), loader.read()]);
      await settle();

      // One initial load plus one refresh, not one per caller.
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('keeps serving the stale value when the background refresh fails', async () => {
      let ok = true;
      const load = jest.fn(async () => {
        if (!ok) throw new Error('down');
        return 'good';
      });
      const loader = createCachedLoader({ ttlMs: 0, timeoutMs: 100, load });

      expect(await loader.read()).toBe('good');
      ok = false;
      expect(await loader.read()).toBe('good');
      await settle();
      expect(await loader.read()).toBe('good');
    });

    it('does not produce an unhandled rejection when a background refresh throws', async () => {
      // The refresh is deliberately not awaited, so nothing observes its
      // rejection. In Node an unobserved rejection can take the process down.
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);

      let ok = true;
      const loader = createCachedLoader({
        ttlMs: 0,
        timeoutMs: 100,
        load: async () => {
          if (!ok) throw new Error('down');
          return 'good';
        }
      });
      await loader.read();
      ok = false;
      await loader.read();
      await settle();

      process.off('unhandledRejection', unhandled);
      expect(unhandled).not.toHaveBeenCalled();
    });
  });

  describe('bootstrap', () => {
    it('serves the shipped value on the very first read', async () => {
      // An edge runtime spawns isolates constantly; without this the first
      // visitor to each new one gets the un-personalized page.
      const load = jest.fn(() => new Promise<string>(() => {}));
      const loader = createCachedLoader({
        ttlMs: 60_000,
        timeoutMs: 50,
        bootstrap: 'shipped',
        load
      });
      expect(await loader.read()).toBe('shipped');
    });

    it('starts a real load immediately rather than sitting on the shipped copy', async () => {
      const load = jest.fn(async () => 'live');
      const loader = createCachedLoader({
        ttlMs: 60_000,
        timeoutMs: 100,
        bootstrap: 'shipped',
        load
      });

      expect(await loader.read()).toBe('shipped');
      expect(load).toHaveBeenCalledTimes(1);
      await settle();
      expect(await loader.read()).toBe('live');
    });

    it('is visible to peek before anything has loaded', async () => {
      const loader = createCachedLoader({
        ttlMs: 60_000,
        timeoutMs: 100,
        bootstrap: 'shipped',
        load: async () => 'live'
      });
      expect(loader.peek()).toBe('shipped');
    });
  });

  it('answers null, not a throw, when the first load fails and there is no bootstrap', async () => {
    const loader = createCachedLoader({
      ttlMs: 100,
      timeoutMs: 100,
      load: async () => {
        throw new Error('down');
      }
    });
    await expect(loader.read()).resolves.toBeNull();
  });

  it('retries after a failure rather than caching it for a TTL', async () => {
    // A failure is remembered for a short, growing wait — never for the TTL.
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    let attempt = 0;
    const load = jest.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('down');
      return 'good';
    });
    const loader = createCachedLoader({ ttlMs: 60_000, timeoutMs: 100, load });
    expect(await loader.read()).toBeNull();
    now += 1_000;
    expect(await loader.read()).toBe('good');
  });

  it('abandons a load that stalls past the deadline', async () => {
    const load = jest.fn(
      (signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const loader = createCachedLoader({ ttlMs: 100, timeoutMs: 30, load });
    await expect(loader.read()).resolves.toBeNull();
  });
});
