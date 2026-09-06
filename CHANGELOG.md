# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.0] — 2026-09-05

First release.

### Added

- `headers` on the endpoint source: sent with every read, so a Vercel preview
  behind Deployment Protection can pass its bypass header and read its own
  rules. Names must be plain header tokens and values single-line, checked at
  construction; an unset value is skipped.
- `matchCampaignRoute(rules, request)` — the matching core. Pure, no
  dependencies, no network, ES 5.1 built-ins only so it runs inside a CloudFront
  Function. About 7 kB built, against that runtime's 10 kB budget, and
  `package-shape.test.ts` fails the build the day it is over.
- `@tailor-ai/campaign-routes/endpoint` — read the rules from a route handler in
  your own app. Returns the rules and the paths that exist in one payload, so
  the "don't rewrite to a page nobody published" check comes for free.
- `@tailor-ai/campaign-routes/contentful` — read them from Contentful directly,
  for runtimes that can.
- `@tailor-ai/campaign-routes/next` — Next.js middleware. Returns a decision so
  the rewrite stays in your own file.
- A CloudFront viewer-request handler, in `examples/lambda-edge` rather than as
  an entry point: it has never run in that runtime, and a published export is a
  promise a README cannot walk back. It becomes an entry point once a real
  deploy has proved it.
- Matchers beyond exact: a `*` wildcard in a parameter value (`"enterprise*"`,
  `"*langsmith*"`, a lone `"*"` for "present"), and operator objects
  `{ contains }`, `{ startsWith }`, `{ endsWith }` and `{ oneOf: [...] }`.
  Paths take no wildcard: a rule is one page served instead of one other page,
  and a star in either path drops the rule. None of it is a regular
  expression, by design. The narrower rule wins: more exact values (so a
  keyword beats a catch-all of lone stars), then more narrowing parameters,
  then more parameters of any kind.
- The route handler's payload carries `version`, the package version it was
  built with, so whoever reads the endpoint can see what a site runs.
- `waitUntil` and `awaitStaleRefresh` on both sources: the first hands the
  refresh behind a stale read to a runtime that would otherwise cancel it
  (Cloudflare Workers, Vercel's edge runtime); the second makes a stale read
  wait instead, for a runtime that freezes the moment the handler returns.
- `maxStaleMs` and `onError` on both sources; see Security below.
- `onMatch`, called when a campaign page is about to be served, so your own
  analytics can attribute a conversion to the campaign. Never awaited, never
  able to throw — including an `async` callback, whose rejection is observed for
  you.
- `bootstrap`, so the first request of a cold isolate is personalized rather than
  not.

### Security

- The endpoint source decides how far to trust a request's own origin from
  where it runs, and fails closed: on Vercel or Netlify the platform vouches
  for the Host header and public origins are read with no configuration; when
  `NODE_ENV` says `development` or `test`, loopback is allowed too; everywhere
  else, an unset `NODE_ENV` included, a request-derived origin reads nothing
  (with one `console.warn`) until `origin` pins the address the app listens
  on, or `trustedOrigins` names the real hostnames a platform deployment
  answers on. Behind that, a literal address only a server could reach
  (private ranges, link-local, carrier-grade NAT, `0.0.0.0`, the IPv6
  unspecified and NAT64 forms, credentials, non-http) is refused under every
  policy. An `origin` or `trustedOrigins` entry that is not an absolute
  origin throws at construction, as does a `path` without a leading slash or
  an `origin` carrying credentials. The endpoint fetch never follows a redirect
  off its own origin (one same-origin hop, for `trailingSlash: true`), and a
  refused origin is reported to `onError` with its reason; a read with no
  origin and none pinned is refused rather than answered from whichever
  origin read last. The literal-address backstop also covers Azure's metadata
  address, `192.0.0.0/24`, `198.18.0.0/15`, multicast, IPv6 multicast and 6to4.
- A duration that is not one (`NaN`, `Infinity`, negative) falls back to its
  default rather than silently disabling the cache, the outage bound or every
  fetch, and the outage bound is never shorter than the TTL.
- Rules are cached per origin, so a forged Host can poison only its own cache,
  and reads in flight are capped across origins so a burst of forged Hosts
  cannot fan out into a burst of server-side requests.
- Cached rules are frozen to the leaf in both sources, so an `onMatch` or
  `pageExists` that edits a rule in place cannot change routing for every later
  visitor on that isolate. A caller's `bootstrap` is copied and frozen rather
  than shared, and rules read from an endpoint's JSON are validated one at a
  time, so a malformed entry is skipped instead of failing the whole payload.
- An empty `paths` list in the endpoint payload now fails closed: it is the
  route handler's statement that the site serves no pages, and every rewrite
  is refused. "Unknown" is spelled by leaving `paths` out. Reading `[]` as
  unknown switched the 404 guard off exactly when a page query had failed into
  an empty array.
- A failing upstream is left alone for a short, doubling wait (1s to 30s)
  while the last good rules keep serving, so a fast 429 or 500 cannot turn
  every page request into an upstream request.
- An outage is bounded: after `maxStaleMs` (default one hour) of failed reads
  both sources answer with no rules, so every visitor gets their original page
  and a campaign somebody unpublished cannot outlive the outage by more than
  that. A shipped `bootstrap` is bound the same way, from the moment the
  source was built. `onError` on both sources reports every failed read to the
  customer's own monitoring, and a throw inside it is swallowed.
- A rule's target must be a rooted path on your own site. An absolute URL, a
  protocol-relative `//host`, a backslash, a control character, `?` or `#` is
  refused. These strings come out of a CMS people edit, and both adapters hand
  the target to a URL resolver — so without this, one published entry could
  serve attacker-chosen content from your own origin.
- Contentful requests go only to `cdn.contentful.com` or
  `preview.contentful.com`. The host is caller-supplied and every request carries
  your delivery token.
