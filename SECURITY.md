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

**The endpoint source reads from the request's origin by default, and keeps
one cache per origin.** `createEndpointRouteSource` fetches its rules from the
site's own origin unless you pin one, which is what lets a preview deploy work
with no configuration. That origin comes from the `Host` header, and behind a
proxy that forwards it, or on any self-hosted Next.js, `Host` is
attacker-supplied. Two things bound what that can do. Caches are held **per
origin**, so rules fetched for a bogus `Host` are only ever served to requests
carrying that same bogus `Host` — a spoofed request can poison the attacker's
own cache and nobody else's, and two real hostnames on one deployment never
share rules or page lists either. And `isInternalPath` confines every target to
your own site's paths regardless.

What a forged `Host` could still do is make the middleware issue one `GET`, to
a fixed path, from inside your network, without seeing the response. So the
default **refuses the destinations only a server could reach**: private ranges,
link-local (which is where every cloud metadata service lives), carrier-grade
NAT, `0.0.0.0`, anything carrying credentials, and anything not `http(s)`. A
request naming one of those reads no rules at all. **Loopback is deliberately
allowed**, because `next dev` runs there and refusing it would break every
developer's first run; a self-hosted production deployment should close it
with one of the two settings below.

**Pass `trustedOrigins`** to read only from hostnames you name, or **pass
`origin`** to ignore the request entirely; once set, neither is ever overridden
by a request.

**The rules endpoint is public by design.** Middleware reads it without
credentials, so anyone can too. It carries every campaign rule — which
parameters route to which page — and the list of paths your site serves. None
of that is secret (the pages are public and the parameters are in your ads),
but it is a tidy summary of your campaign targeting in one place. If that
matters to you, gate the route on a header your middleware sends and this
package does not know about.

## What it deliberately does not do

- No telemetry, no logging, no network call other than to the customer's own CMS
  or their own endpoint.
- No cookies and no visitor state.
- No `eval`, no dynamic `import`, no runtime dependencies.

## Supported versions

Pre-1.0. Fixes land on the latest minor.
