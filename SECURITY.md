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
a fixed path, from inside your network, without seeing the response. So how
far the request's origin is trusted depends on where the code runs, and the
default fails closed:

- **On a platform that routes by hostname** (Vercel, Netlify), the platform
  never hands your app a request whose Host it did not itself resolve, so the
  origin is the platform's word rather than the client's. Public origins are
  read with no configuration; loopback is not.
- **In development** — a build that says so, `NODE_ENV` of `development` or
  `test` — public origins and loopback both, so `next dev` works with no
  configuration.
- **Everywhere else**, including an unset `NODE_ENV` and a runtime with no
  `process` at all — self-hosted, behind a proxy that forwards Host, a
  Cloudflare Worker — a request-derived origin reads **nothing** until you say
  where the rules are, and the source says so with a single `console.warn`
  rather than silently switching every campaign off. Unknown is refused,
  never assumed to be development.

Behind the policy, a backstop: a request-derived origin naming a **literal
address** only a server could reach is refused under every policy — private
ranges, link-local (where every cloud metadata service lives), carrier-grade
NAT, `0.0.0.0`, the IPv6 unspecified and NAT64 forms, anything carrying
credentials, anything not `http(s)`. It is a backstop and not the gate because
nothing here resolves DNS: a hostname pointing at one of those addresses passes
the literal check, and what stops that fetch is the policy above — nothing is
read under `refuse`, the platform vouched for the name under `platform`, and
only the names you listed are read under `trustedOrigins`. Reads in flight are
capped across all origins, so a burst of forged Hosts cannot fan out into a
burst of server-side requests. The fetch itself never follows a redirect off
the origin it was checked against (one same-origin hop is allowed, for a Next
app with `trailingSlash: true`), so an endpoint that answers `302 Location:
http://169.254.169.254/` is a failed read, not a request. And a refusal is
never silent: the console hears about the first one, and `onError` is handed
every refused origin with the reason (`kind: 'origin_refused'`).

**Self-hosting with `next start`: pass `origin`**, the address the app listens
on (`http://localhost:3000`). The origin the middleware sees there is the one
Next is bound to, not the public hostname — verified against a production
build — so an allowlist of public hostnames would match nothing, and pinning
the listen address is both the working answer and the closed one: the request
is never consulted. **On a platform that answers on several real hostnames,
pass `trustedOrigins`** to read only from the ones you name. Once set, neither
is ever overridden by a request.

**The rules endpoint is public by design.** Middleware reads it without
credentials, so anyone can too. It carries every campaign rule — which
parameters route to which page — the list of paths your site serves, and the
version of this package your route handler was built with. None of that is
secret (the pages are public, the parameters are in your ads, and the version
is what a dependency scanner reads off your lockfile anyway),
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
