# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.0] — unreleased

First release. Not yet published.

### Added

- `matchCampaignRoute(rules, request)` — the matching core. Pure, no
  dependencies, no network, ES 5.1 built-ins only so it runs inside a CloudFront
  Function. 3.9 kB built, against that runtime's 10 kB budget.
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
- `onMatch`, called when a campaign page is about to be served, so your own
  analytics can attribute a conversion to the campaign. Never awaited, never
  able to throw — including an `async` callback, whose rejection is observed for
  you.
- `bootstrap`, so the first request of a cold isolate is personalized rather than
  not.

### Security

- A rule's target must be a rooted path on your own site. An absolute URL, a
  protocol-relative `//host`, a backslash, a control character, `?` or `#` is
  refused. These strings come out of a CMS people edit, and both adapters hand
  the target to a URL resolver — so without this, one published entry could
  serve attacker-chosen content from your own origin.
- Contentful requests go only to `cdn.contentful.com` or
  `preview.contentful.com`. The host is caller-supplied and every request carries
  your delivery token.
