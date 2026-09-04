# Security

## Reporting a vulnerability

Email **security@tailorhq.ai**. Please do not open a public issue.

Include what you can reproduce and what it lets an attacker do. We will
acknowledge within two business days.

## What this package is trusted with

It runs on the request path of every page of a marketing site and decides which
page a visitor is served. Two things follow.

**The rules come from a CMS that people edit**, so a rule is untrusted input.
`isInternalPath` in `src/core/match.ts` is the boundary: a target must be a
rooted path on the site's own origin, and an absolute URL, a protocol-relative
`//host`, a backslash, a control character, `?` or `#` is refused. Without it,
one published entry serves attacker-chosen content from the customer's own
origin — reached from a live ad click, which is both stored XSS and a phishing
surface on a domain their visitors trust.

Backslashes and control characters are refused for a reason worth knowing: a URL
parser reads `\` as `/`, and the URL spec strips tab, LF and CR *before* parsing.
So `/\evil.example` and `/<tab>/evil.example` are both protocol-relative URLs by
the time anything resolves them, and a check that only looked at the first
character would pass them.

**It holds a delivery token.** The Contentful host is caller-supplied, so it is
allowlisted to `cdn.contentful.com` and `preview.contentful.com` — every request
carries `Authorization: Bearer <token>`, and a host read from deploy config is
one mistake away from sending it elsewhere. It throws at construction rather than
per request, so the failure lands where somebody is looking.

## What it deliberately does not do

- No telemetry, no logging, no network call other than to the customer's own CMS
  or their own endpoint.
- No cookies and no visitor state.
- No `eval`, no dynamic `import`, no runtime dependencies.

## Supported versions

Pre-1.0. Fixes land on the latest minor.
