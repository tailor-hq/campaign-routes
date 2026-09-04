import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The core has to run inside a CloudFront Function, and that runtime is
 * ECMAScript 5.1 compliant with only *some* ES6-12 features — the list does not
 * promise the ones below.
 *
 * **TypeScript downlevels syntax and does not polyfill library functions.** So
 * `const`, arrow functions and template literals are safe and compile away,
 * while `Object.entries`, `Array.prototype.find` and `String.prototype.startsWith`
 * compile straight through and then throw at runtime.
 *
 * That failure has the worst possible shape: not a build error, but a live ad
 * quietly serving the wrong page in production, on the one customer stack that
 * has no other integration point. It is also exactly the kind of constraint a
 * later editor cannot see — `.find()` is more readable than an index loop and
 * there is nothing in the file to say why it is not used.
 *
 * So the rule is enforced against the SOURCE rather than trusted to a comment.
 *
 * # It scans src/core/ and nothing else, deliberately
 *
 * The constraint comes from ONE runtime. Lambda@Edge runs Node and a Next.js
 * middleware runs the Edge runtime; both are modern, and holding the adapters
 * to ES 5.1 would be a cost paid for nothing - await alone is unavoidable
 * there. The directory boundary is what keeps the rule where it earns its
 * keep, and it is why the adapters live outside this folder rather than
 * beside the core.
 */
const SOURCE_DIR = join(__dirname);

/** Post-ES5 built-ins TypeScript will not polyfill. */
const FORBIDDEN: Array<{ pattern: RegExp; what: string; instead: string }> = [
  { pattern: /\bObject\.entries\b/, what: 'Object.entries', instead: 'Object.keys with an index loop' },
  { pattern: /\bObject\.values\b/, what: 'Object.values', instead: 'Object.keys with an index loop' },
  { pattern: /\bObject\.assign\b/, what: 'Object.assign', instead: 'an explicit copy' },
  { pattern: /\bObject\.fromEntries\b/, what: 'Object.fromEntries', instead: 'building the object in a loop' },
  { pattern: /\.\s*includes\s*\(/, what: '.includes()', instead: '.indexOf(x) !== -1' },
  { pattern: /\.\s*startsWith\s*\(/, what: '.startsWith()', instead: '.indexOf(x) === 0' },
  { pattern: /\.\s*endsWith\s*\(/, what: '.endsWith()', instead: 'a charAt or substring check' },
  { pattern: /\.\s*find\s*\(/, what: '.find()', instead: 'an index loop' },
  { pattern: /\.\s*findIndex\s*\(/, what: '.findIndex()', instead: 'an index loop' },
  { pattern: /\.\s*flat\s*\(/, what: '.flat()', instead: 'an index loop' },
  { pattern: /\.\s*padStart\s*\(/, what: '.padStart()', instead: 'manual padding' },
  { pattern: /\.\s*trimStart\s*\(/, what: '.trimStart()', instead: '.trim() or a regex' },
  { pattern: /\bnew\s+Map\b/, what: 'Map', instead: 'a plain object with hasOwnProperty' },
  { pattern: /\bnew\s+Set\b/, what: 'Set', instead: 'a plain object with hasOwnProperty' },
  { pattern: /\bURLSearchParams\b/, what: 'URLSearchParams', instead: 'a plain Record the adapter parses' },
  { pattern: /\bPromise\b/, what: 'Promise', instead: 'nothing — the core is synchronous by design' },
  { pattern: /\basync\s/, what: 'async', instead: 'nothing — the core is synchronous by design' },
  { pattern: /\?\./, what: 'optional chaining', instead: 'an explicit guard' },
  { pattern: /\?\?/, what: 'nullish coalescing', instead: 'an explicit guard' }
];

const sourceFiles = readdirSync(SOURCE_DIR).filter(
  (name) => name.endsWith('.ts') && !name.endsWith('.test.ts')
);

describe('the core stays runnable inside a CloudFront Function', () => {
  it('ships some source to check', () => {
    // A rename that emptied this list would make every test below vacuously
    // pass, which is the failure mode a guard like this most often dies of.
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it.each(sourceFiles)('%s uses ES 5.1 built-ins only', (name) => {
    const source = readFileSync(join(SOURCE_DIR, name), 'utf8');
    // Comments explain WHY these are banned and necessarily name them, so they
    // are stripped before the check rather than the prose being contorted.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    const found = FORBIDDEN.filter((rule) => rule.pattern.test(code)).map(
      (rule) => `${rule.what} — use ${rule.instead}`
    );
    expect(found).toEqual([]);
  });
});
