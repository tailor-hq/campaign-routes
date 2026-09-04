import { notifyMatch, type CampaignMatchEvent } from './on-match.js';

const EVENT: CampaignMatchEvent = {
  requestedPath: '/pricing',
  targetPath: '/pricing-enterprise',
  matchParams: { utm_campaign: 'enterprise' },
  route: {
    basePath: '/pricing',
    matchParams: { utm_campaign: 'enterprise' },
    targetPath: '/pricing-enterprise'
  }
};

describe('notifyMatch', () => {
  it('calls the callback with what served and why', () => {
    const onMatch = jest.fn();
    notifyMatch(onMatch, EVENT);
    expect(onMatch).toHaveBeenCalledWith(EVENT);
  });

  it('does nothing when no callback was given', () => {
    expect(() => notifyMatch(undefined, EVENT)).not.toThrow();
  });

  it('ignores a value that is not callable', () => {
    expect(() => notifyMatch('analytics' as never, EVENT)).not.toThrow();
  });

  it('swallows a callback that throws', () => {
    // This runs on the request path of every campaign click, in a runtime where
    // an uncaught throw is a 5xx. Their analytics is not worth their page.
    const onMatch = () => {
      throw new Error('analytics endpoint refused the connection');
    };
    expect(() => notifyMatch(onMatch, EVENT)).not.toThrow();
  });

  it('does not await a callback that returns a promise', () => {
    // A hanging analytics call must not hold the page. If this were awaited the
    // test would time out rather than fail.
    let settled = false;
    const onMatch = () =>
      new Promise(() => {
        settled = true;
      }) as unknown as void;
    notifyMatch(onMatch, EVENT);
    expect(settled).toBe(true);
  });

  it('does not produce an unhandled rejection from an async callback', async () => {
    // `onMatch` is typed void, but `async (e) => fetch(...)` is the obvious way
    // to send a beacon and nothing stops a customer writing it. A dropped
    // rejection is a warning under jest and a terminated process in a Lambda —
    // this test is what caught that the try/catch alone did not cover it.
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    notifyMatch(() => Promise.reject(new Error('beacon refused')) as unknown as void, EVENT);
    await new Promise((resolve) => setTimeout(resolve, 0));

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
