# Design notes

The reasoning behind `@tailor-ai/campaign-routes`, for an engineer reviewing
it. The [README](../README.md) is the front page; this is the long version.

## Why the rules live in your CMS

Routing rules in a content system can look odd to an engineer the first time.
Two things are worth knowing before deciding it is.

**It is the established pattern for anything marketing changes more often than
the site deploys.** A "Redirect" content type read by middleware is a stock
Contentful setup, for exactly this reason; Contentful's own personalization
product keeps its audience and variant rules as entries in the space; every
personalization platform that works with a headless CMS does the same. A rule
here is the same shape: "this page, for visitors who arrived from that ad,
serve that page instead". That is a statement about content, so it belongs with
the content, under the roles, workflows and publish gates the content already
has. Tailor writes every rule as a draft; someone on your team publishing it is
what turns the campaign on, and unpublishing it is what turns it off (as long
as your route handler reads with the Delivery client, which serves published
entries only, and not the Preview one). No new permission, no new tool, no
request to an engineer per campaign.

**The alternatives are each worse in a specific way.** `rewrites()` in
`next.config.js` means a deploy per campaign, which is the cost this removes.
Reading `searchParams` inside the page opts the whole route out of static
generation, so every marketing page renders per request for the organic
majority that carries no campaign (measured: one such read turned a `[...slug]`
catch-all dynamic). A personalization service that decides at the edge puts a
vendor in your request path, and this package's whole design is that nothing
except your own CMS and your own app is in it.

What this does *not* put in your CMS: any logic. The matching, the refusal to
rewrite off-site, the caching and the failure behaviour are all in this
package, versioned and tested. The CMS holds three fields per campaign, and a
person who can publish a page can publish one.

## Why a route handler and not a CMS read from the edge

Middleware runs before your app, so your content SDK is not available to it;
you need a route either way. And because that route runs *inside* the app, it
can return the rules **and the paths that exist**, which is what stops a rule
published before its page from turning a live ad into a 404. Reading the CMS
from the edge cannot answer that.

`paths` is a statement, so make it a true one. An empty list says the site
serves no pages and refuses every rewrite; leaving it out says the inventory is
unknown, which protects nothing. Return the real list, or none, and never let a
failed page query become `[]`.

## How matching is defined

**A rule matches when the request carries everything it names, and may carry
more.** A real ad click never arrives with only the parameters somebody targeted
on: Google appends `gclid`, Meta appends `fbclid`, your analytics adds its own.
A rule demanding an exact parameter set would match in testing and never once
in production. Values compare case-insensitively; keys do not.

`basePath` and the request path compare ignoring trailing slashes and case;
the page that gets served is `targetPath` with its case preserved (surrounding
whitespace and a trailing slash trimmed). An empty string as a parameter value
matches a parameter that is present and empty (`?utm_term=`).

**Paths take no wildcard.** A rule replaces the whole page, so `/blog/*` would
send every visitor who clicked through to a specific post to the same campaign
page, and one typo would take a section with it. Matching a section is for
tools that change an element on each page, not for a rewrite. A `basePath` or
`targetPath` containing `*` makes the rule unusable; it is dropped, not matched
literally.

**None of the matchers is a regular expression, and none will be.** These
strings are typed by marketers and run on every ad click, and a pattern that
can be made to backtrack is a way to take a site down from a content field.
Every form is a handful of `indexOf` calls; a wildcard is matched segment by
segment with a cursor that only moves forward.

**Precedence.** When two rules match, the narrower one wins: more exact values
beat fewer (so a rule naming the actual keyword beats a catch-all of lone `*`s,
however many parameters the catch-all names), then more narrowing parameters,
then more parameters of any kind. On a genuine tie the target path decides,
which is arbitrary and deliberately deterministic: two equally specific rules is
a mistake in your content, and the failure it must not produce is a page that
alternates between versions depending on which entry came back first.

## Where the rules are read from, and who is trusted

The middleware reads `/api/campaign-routes` on the request's own origin, which
is what lets a preview deploy work with no configuration. That origin comes
from the `Host` header, so how far it is trusted depends on where the code
runs:

- **On Vercel** the platform never hands your app a request whose Host it did
  not itself resolve, so public origins are read with no configuration.
  (Netlify is treated the same way and has not been driven here yet.) A
  preview behind Vercel's Deployment Protection answers the middleware's own
  fetch with a redirect to Vercel's login page, which the package refuses to
  follow because it never leaves the origin it was told to read, so campaigns
  are off there until the read is let through. Seen on a protected preview:
  `onError` receives "campaign routes endpoint redirected off its own origin"
  and every visitor gets their original page. The way through is Vercel's
  Protection Bypass for Automation: switch it on for the project, and pass
  `headers: { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET }`
  to `createEndpointRouteSource`. The header travels only to the origin the
  policy approved, and an unset variable sends nothing, so the same line is
  harmless in production.
- **In development** (`NODE_ENV` of `development` or `test`) loopback is
  allowed too, so `next dev` works with no configuration.
- **Everywhere else**, including an unset `NODE_ENV`, a request-derived origin
  reads nothing (and warns once, and tells `onError`) until you say where the
  rules are.

**Self-hosting with `next start`: pin `origin`** to the address the app listens
on (`http://localhost:3000`). The origin the middleware sees there is the one
Next is bound to, not the public hostname, so an allowlist of public hostnames
would match nothing. **On a platform answering on several real hostnames, pass
`trustedOrigins`** to read only from the ones you name. And do not ship a
`vercel env pull` `.env.local` to a self-hosted production: it carries
`VERCEL=1`, which would make that box trust the Host header as if the platform
stood behind it; pinning `origin` closes that regardless.

The full policy, the refused address ranges, and the redirect rules are in
[SECURITY.md](../SECURITY.md).

## Refresh, outage and the first request

After the first load, rules are served from memory and refreshed behind the
request, so no visitor waits on your CMS. The trade: a newly published
campaign can take up to twice the TTL to appear (plus the route handler's own
`revalidate`), because the request that notices the cache has lapsed is still
served the old rules. Ship a `bootstrap` payload if you want the first request
of a cold isolate personalized too.

On Cloudflare Workers or Vercel's edge runtime, pass the runtime's own
`waitUntil` so the refresh behind a response is not cancelled with it. On a
runtime that freezes the moment the handler returns, such as Lambda@Edge, pass
`awaitStaleRefresh: true` and accept one blocking read per TTL per isolate
rather than unbounded staleness.

When your CMS or endpoint stops answering, the last good rules keep serving and
the upstream is retried with a doubling wait (1 s to 30 s). After `maxStaleMs`
(default one hour) of failed reads every visitor gets their original page until
a read succeeds, so a campaign you unpublished to pull bad content cannot
outlive an outage by more than that. Pass `onError` to hear about every failed
read; the package itself logs nothing except one `console.warn` the first time
it refuses to read rules for a request origin.

## What it will not do, in full

- **It never fails your page load, once the source is built.** Every error
  path at request time returns "serve the page you were going to serve". The
  one place it throws is construction: a malformed `origin`, `trustedOrigins`
  entry, `path` or Contentful `host` throws when the source is created. On
  Next.js the source is built at module scope of `middleware.ts`, and that
  module is evaluated on the first request after a deploy, not by
  `next build`, so a bad value (an env variable unset in production, say
  `origin: process.env.SELF_ORIGIN ?? ''`) fails every request the middleware
  covers until it is fixed, with an error that names the option. Throwing is
  still the right call, because the alternative is silently falling through to
  request trust nobody asked for; the mitigation is to check configuration on
  a preview deploy before promoting.
- **It never sends a visitor off your site.** A rule whose target is an
  absolute URL, a protocol-relative `//host`, or carries a backslash, control
  character, `?` or `#` is refused. These strings come out of a CMS that
  people edit, and the adapter hands the target to a URL resolver.
- **It never redirects.** The address bar does not change, so your ad keeps
  its clean destination and your analytics keeps its parameters.
- **It phones nothing home.** No telemetry, no logger. Use `onMatch` to tell
  your own analytics.
- **It sets no cookies and remembers no visitor.** The campaign applies to the
  click the ad paid for and not to the rest of the session: the campaign page
  *is* the landing page, and a cookie that kept rewriting `/pricing` afterwards
  would personalize navigation nobody bought. There is also then nothing to
  put in a consent banner.

## Knowing when a campaign served

The package sends nothing anywhere, so nothing in your stack knows a campaign
page served unless you tell it. `onMatch` is the seam:

```ts
const target = await campaignRouteFor(request, source, {
  onMatch: ({ requestedPath, targetPath, matchParams }) => {
    analytics.track('campaign_page_served', { requestedPath, targetPath, matchParams });
  },
});
```

It is never awaited and never allowed to throw, so an analytics call that hangs
cannot hold the page and one that fails cannot lose it, including an `async`
callback, whose rejection is observed for you. It fires when a rule wins, a
moment before your middleware performs the rewrite.

## You are not cloaking

Cloaking is showing a crawler different content than a visitor *at the same
URL*. Crawlers do not send `utm_*`, so they get the original page; the
behaviour is correct by construction. It stops being correct if somebody writes
a rule keyed on something a crawler *does* send, so don't.

## How far it scales

The rules live in memory, one copy per server isolate, refreshed once per TTL.
Two costs grow with the number of rules: the payload each isolate re-reads
every minute, and the per-request scan, which is linear and runs only for
requests that carry a query string. Measured on a laptop (an edge isolate is a
few times slower and has 128 MB):

| Rules | Payload per refresh | Refresh (parse + validate) | Memory held | Per campaign request |
| --- | --- | --- | --- | --- |
| 1,000 | 151 KB | 0.7 ms | 228 KB | 0.13 ms |
| 10,000 | 1.4 MB | 6.5 ms | 2.2 MB | 1.4 ms |
| 50,000 | 7.3 MB | 38 ms | 11 MB | 7 ms |

A rule is one campaign on one page, so a site with hundreds of pages and a
few campaigns each is in the low thousands, where none of this registers.
Past about 10,000 the per-minute payload and the per-request scan are worth
looking at, and that is also where the Contentful source stops on its own: it
reads at most ten pages of 1,000 entries. If a site ever gets there, indexing
rules by `basePath` turns the scan into a lookup, and the sources are where
that change would go.

## Next.js version note

A middleware rewrite **silently disabled ISR in Next 15.4.2-canary.2 through
15.5.21**: the page stays correct and simply stops being cached. Check for it
in one line:

```bash
curl -sI 'https://yoursite.com/pricing?utm_campaign=enterprise' | grep -i 'x-nextjs-prerender\|cache-control'
```

You want `x-nextjs-prerender: 1` and an `s-maxage`. If you see
`Cache-Control: private, no-cache, no-store` and no prerender header, you are on
an affected version. Measured green on Next 16.3.0.

## Other runtimes

The matching core uses ES 5.1 built-ins only and has no dependencies, so it
runs inside a CloudFront Function, the one interception point on a statically
exported site and the one that cannot make network calls. An unpublished
CloudFront/Lambda@Edge example lives in [`examples/lambda-edge`](../examples/lambda-edge);
it has not run in that runtime yet, which is why it is an example and not an
entry point.
