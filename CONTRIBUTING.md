# Contributing

```bash
npm install
npm test
npm run lint      # typechecks the source and the tests
npm run build     # declarations, then JavaScript with comments stripped
```

## The three rules this package is built on

Everything below follows from these, and a change that breaks one needs a very
good argument.

**1. It never fails a page load.** This runs on the request path of every page
of somebody's marketing site, in runtimes we do not operate and cannot roll
back. Every error path — the CMS down, a stalled connection, a malformed rule, a
bug in here — returns "serve the page you were going to serve". There is no
configuration for this and no code path that throws to a caller.

**2. The core stays runnable inside a CloudFront Function.** That means ES 5.1
built-ins only in `src/core/`: no `Object.entries`, no `.includes()`, no
`.find()`, no `Map`, no `Promise`, no optional chaining. TypeScript downlevels
*syntax* and does not polyfill *library* functions, so the failure is not a build
error — it is a live ad silently serving the wrong page. `es5-safe.test.ts`
scans the source and `package-shape.test.ts` pins the byte budget.

The adapters are outside `src/core/` precisely so they are not held to this.

**3. A rule's target is never trusted.** These strings come out of a CMS that
people edit, and both adapters hand the target to a URL resolver. `isInternalPath`
is the security boundary of the whole package.

## What a change needs

- **A test that fails without it.** For anything touching a refusal, break the
  code deliberately and watch the tests go red before you restore it — a refusal
  held only by a test nobody has seen fail is not held.
- **The corner cases, not just the happy path.** Empty input, one item where the
  code assumes many, an upstream failure or timeout, absent versus false, the
  operation running twice.
- **A comment saying *why*, where the reason is not obvious.** The source is
  deliberately well commented and the published JavaScript is deliberately not —
  `tsconfig.build.json` strips it, so writing a good comment costs a customer
  nothing.
- **A CHANGELOG entry**, under `## [Unreleased]`.

## What does not belong here

- **Runtime dependencies.** There are none and there should stay none.
- **Telemetry, logging, or any network call other than to the customer's own
  CMS or endpoint.** `onMatch` is the seam for anyone who wants to know
  something; it is their callback and their destination.
- **Cookies or visitor state.** The campaign applies to the click the ad paid
  for. Persisting it would personalize navigation nobody bought, and would drag
  a consent banner in behind it.
