# @tailor-ai/campaign-routes

Serve the campaign page a visitor should get, from rules your marketing team
publishes in **Contentful**, on a **Next.js** site.

- **What:** a visitor who arrives from an ad (`/pricing?utm_campaign=enterprise`) is served your campaign page (`/pricing-enterprise`) at the original URL. Everyone else gets `/pricing`.
- **How:** a Campaign Route entry in Contentful says which page, for which ad parameters. Your app exposes those rules at one route; its middleware reads them once a minute and rewrites matching requests.
- **Install:** two files in your Next.js app. After that, every campaign is a publish in Contentful, not a deploy.
- **Never:** never calls Tailor, never fails a page load, never redirects, never rewrites off your site, never sets a cookie.
- **Works with:** Contentful and Next.js today. Other CMSs are one small adapter away; the matching itself runs anywhere JavaScript does.
- **Status:** pre-1.0, MIT.

```
/pricing                            → your pricing page
/pricing?utm_campaign=enterprise    → the campaign page, at the same URL
```

No redirect, no flash, no client-side swap. A crawler that runs no JavaScript
sees what a person sees.

## How it works

1. **A rule lives in Contentful.** A Campaign Route entry says: on this page
   (`basePath`), for a visitor whose URL carries these parameters
   (`matchParams`), serve that page instead (`targetPath`). Publishing turns a
   campaign on; unpublishing turns it off.
2. **Your app exposes its rules at one URL.** A route handler at
   `/api/campaign-routes` reads the entries with the Contentful client you
   already have and returns them with the list of pages your site serves.
3. **Middleware decides per request.** For a request carrying a query string,
   it matches against the rules and rewrites to the campaign page on a hit. It
   reads the rules from `/api/campaign-routes`, keeps them in memory for 60
   seconds, and refreshes behind a response, so after the first load no
   visitor waits on the read (ship a `bootstrap` and not even the first one
   does).

```
marketer publishes     your route handler         middleware, per isolate      per request
a Campaign Route  ───▶ /api/campaign-routes  ───▶ rules cached 60s, refreshed ───▶ match ───▶ rewrite
in Contentful          returns rules + pages       behind the response              (or leave alone)
```

A publish is live on every server within a few minutes, with no deploy.

## Install

```bash
npm install @tailor-ai/campaign-routes
```

ESM only. Next.js projects on `bundler` or `node16` module resolution resolve
it; `moduleResolution: "node"` and CommonJS `require` do not.

`middleware.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { createEndpointRouteSource } from '@tailor-ai/campaign-routes/endpoint';
import { campaignRouteFor } from '@tailor-ai/campaign-routes/next';

// On Vercel this is enough. Self-hosting with `next start`? Pin the address
// your app listens on: createEndpointRouteSource({ origin: 'http://localhost:3000' })
const source = createEndpointRouteSource();

export async function middleware(request: NextRequest) {
  const target = await campaignRouteFor(request, source);
  if (!target) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = target;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/).*)'],
};
```

`app/api/campaign-routes/route.ts`:

```ts
import { campaignRoutesPayload } from '@tailor-ai/campaign-routes/endpoint';
import { CAMPAIGN_ROUTE_TYPE_ID, toCampaignRoutes } from '@tailor-ai/campaign-routes/contentful';
import { client } from '@/lib/contentful'; // your existing Delivery client

export const revalidate = 60;

const getCampaignRoutes = async () =>
  toCampaignRoutes((await client.getEntries({ content_type: CAMPAIGN_ROUTE_TYPE_ID })).items, 'en-US');

export async function GET() {
  const [rules, pages] = await Promise.all([getCampaignRoutes(), getAllPages()]);
  return Response.json(campaignRoutesPayload(rules, pages.map((p) => p.path)));
}
```

`getAllPages()` is whatever already lists the pages your site serves. That
list is how a rule whose page is not published yet is skipped instead of
becoming a 404. Leave `paths` out if you cannot list pages; never pass `[]`
as a placeholder, which means "no pages exist".

## The rules

Three fields per entry, all in Contentful:

```json
{
  "basePath": "/pricing",
  "matchParams": { "utm_campaign": "enterprise" },
  "targetPath": "/pricing-enterprise"
}
```

- A rule matches when the request carries **every** parameter it names (a
  real ad click also carries `gclid` and friends, which is fine). Values
  compare ignoring case.
- `basePath` and `targetPath` are one page each, rooted on your site. No
  wildcards in paths.
- When several rules match, the narrowest wins: exact values beat patterns,
  then more parameters. Ties are resolved deterministically.

A parameter value can be more than an exact string:

| `matchParams` value | Matches when the request's value… |
| --- | --- |
| `"enterprise plan"` | is exactly that |
| `"enterprise*"` | starts with `enterprise` (`*` is any run of characters; `"*x*"` is "contains", `"*"` is "present") |
| `{ "contains": "langsmith" }` | contains it |
| `{ "startsWith": "enterprise" }` | starts with it |
| `{ "endsWith": " pricing" }` | ends with it |
| `{ "oneOf": ["a", "b*"] }` | matches any entry |

None of these is a regular expression, on purpose.

## Options

`createEndpointRouteSource({ ... })`:

| Option | Default | What it does |
| --- | --- | --- |
| `origin` | the request's own origin | Pin where the rules are read from. Use it when self-hosting. |
| `trustedOrigins` | none | The full origins this deployment answers on, e.g. `['https://www.example.com', 'https://example.com']`; a request for any other reads nothing. |
| `ttlMs` | 60 s | How long rules are reused before a refresh. |
| `maxStaleMs` | 1 h | How long the last good rules keep serving while the endpoint is down; after that, visitors get their original page. |
| `bootstrap` | none | Rules to serve before the first read, so a cold server's first visitor is personalized too. |
| `onError` | none | Called on every failed read, for your own monitoring. |
| `waitUntil` | none | Your runtime's hook to keep the background refresh alive (Cloudflare Workers, Vercel's edge runtime). |

`campaignRouteFor(request, source, { onMatch })` calls `onMatch` when a
campaign page is about to be served, so your own analytics can attribute the
conversion. It is never awaited and cannot throw into the request.

## Guarantees

- **Never fails a page load.** Every error at request time, the CMS down or a
  malformed rule, means "serve the page you were going to serve". The one
  exception is a malformed configuration (a bad `origin`, `trustedOrigins`
  entry or `path`): the source throws when the middleware module loads, which
  on Next.js is the first request after a deploy, and every request the
  middleware covers fails until it is fixed. The error names the option.
  Check configuration on a preview deploy before promoting.
- **Never sends a visitor off your site.** A target that is not a rooted path
  on your own site is refused.
- **Never redirects, never sets a cookie, never phones home.** The only
  network calls are to your own endpoint and your own CMS.
- **Keeps serving through an outage, for an hour.** Then falls back to the
  original page until a read succeeds.

Full detail, including the security model: [SECURITY.md](./SECURITY.md).

## Before you ship

- **Your CDN must key on the query string.** A cache that strips query
  parameters will store the campaign page under `/pricing` and serve it to
  everyone.
- **Give campaign pages a `noindex` or a canonical** back to the original, so
  the two near-duplicate pages do not compete in search.

## Not on Next.js, or not on Contentful?

The decision is one pure function with no dependencies, no network and no
framework:

```ts
import { matchCampaignRoute } from '@tailor-ai/campaign-routes';

const match = matchCampaignRoute(rules, { path, searchParams }); // → { targetPath, route } | null
```

Give it the rules from wherever you can get them and act on the answer in
your own middleware or worker. A second CMS is a `RouteSource` that turns its
entries into the three fields above; the Contentful one is the model.

## Further reading

<a id="why-the-rules-live-in-your-cms"></a><a id="how-far-it-scales"></a>

- [Design notes](./docs/design-notes.md): why the rules live in your CMS, how
  far the in-memory design scales (measured), how precedence and matching are
  defined, self-hosting and origin trust, outage behaviour, and a Next.js
  version to avoid.
- [SECURITY.md](./SECURITY.md) and [CHANGELOG.md](./CHANGELOG.md).

## License

MIT. See [LICENSE](./LICENSE).
