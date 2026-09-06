import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What a customer actually receives, asserted rather than assumed.
 *
 * Everything here is invisible from inside the repo and only shows up once
 * somebody has installed the package — which is the worst moment to find it.
 * Each case below is a real defect that shipped or nearly shipped:
 *
 * - The tarball carried no README and no LICENSE. Twenty-five files of `dist/`
 *   and a `package.json`, with the install guide in a repo they never see.
 * - `dist/core/match.js` shipped at 12,436 bytes, of which the code minifies to
 *   1,531 — the rest was our own comments, and it pushed the file past the 10KB
 *   budget of a CloudFront Function, the one runtime the core exists to fit.
 * - Stripping those comments then took the JSDoc out of the `.d.ts` too, which
 *   removes every parameter description from the customer's editor. Invisible
 *   until somebody hovers.
 *
 * The build is a prerequisite. `npm run build` runs before `npm pack`, and CI
 * builds before it tests.
 */
const PACKAGE_ROOT = join(__dirname, '..');
const DIST = join(PACKAGE_ROOT, 'dist');

const built = existsSync(DIST);
const describeBuilt = built ? describe : describe.skip;

/** CloudFront Functions cap the code at 10KB. The core has to fit, uncompressed. */
const CLOUDFRONT_CODE_LIMIT_BYTES = 10 * 1024;

describe('what ships to npm', () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));

  it('stamps the version it was built as, so an endpoint can say which package is deployed', async () => {
    // A JSON import would land in the edge bundle and the runtime cannot read
    // package.json, so the version is a constant; this is what keeps it honest.
    const { VERSION } = await import('./version.js');
    expect(VERSION).toBe(pkg.version);
  });

  it('ships the README and the LICENSE, not just dist', () => {
    expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'README.md', 'LICENSE']));
    expect(existsSync(join(PACKAGE_ROOT, 'README.md'))).toBe(true);
    expect(existsSync(join(PACKAGE_ROOT, 'LICENSE'))).toBe(true);
  });

  it('carries the metadata npm and a reader expect', () => {
    // A package page with no repository, no homepage and no issue link reads as
    // abandoned regardless of how good the code is.
    expect(pkg.description).toBeTruthy();
    expect(pkg.license).toBe('MIT');
    expect(pkg.repository?.url).toContain('github.com');
    expect(pkg.homepage).toContain('github.com');
    expect(pkg.bugs?.url).toContain('issues');
    expect(pkg.engines?.node).toBeTruthy();
    expect(Array.isArray(pkg.keywords) && pkg.keywords.length).toBeTruthy();
  });

  it('declares an entry point for every adapter', () => {
    // A missing `exports` entry is a module-not-found at the customer's build,
    // and nothing here would otherwise notice a new adapter that forgot one.
    for (const entry of ['.', './endpoint', './contentful', './next']) {
      expect(pkg.exports[entry]).toBeDefined();
      expect(pkg.exports[entry].types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
    }
  });

  it('publishes nothing that has not run somewhere real', () => {
    // The published surface is a promise, and a disclaimer in a README does not
    // stop anybody importing what is exported. `lambda-edge` had never run in
    // Lambda@Edge — its own documented snippet read `process.env`, which that
    // runtime does not provide — so it lives in `examples/` until a real deploy
    // earns it a place here.
    //
    // The asymmetry is the argument: adding an entry point later is a minor
    // version, removing one is a breaking change on a package whose whole pitch
    // is a frictionless install.
    expect(pkg.exports['./lambda-edge']).toBeUndefined();
    expect(Object.keys(pkg.exports).sort()).toEqual(
      ['.', './contentful', './endpoint', './next'].sort()
    );
  });

  it('has no runtime dependencies', () => {
    // The selling point, and the thing most easily lost in a hurry.
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('is publishable', () => {
    // `"private": true` makes npm refuse to publish whatever `--access` says,
    // and the release workflow's `--access public` assumes it is absent.
    expect(pkg.private).toBeUndefined();
  });
});

describeBuilt('the built output', () => {
  const jsFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? jsFiles(join(dir, entry.name))
        : entry.name.endsWith('.js')
          ? [join(dir, entry.name)]
          : []
    );

  it('builds something to check', () => {
    expect(jsFiles(DIST).length).toBeGreaterThan(0);
  });

  it('strips our comments out of the JavaScript', () => {
    for (const file of jsFiles(DIST)) {
      const source = readFileSync(file, 'utf8');
      expect({ file, hasBlockComment: source.includes('/*') }).toEqual({
        file,
        hasBlockComment: false
      });
    }
  });

  it('keeps the JSDoc in the declarations, where a customer hovers', () => {
    const declaration = readFileSync(join(DIST, 'core', 'match.d.ts'), 'utf8');
    expect(declaration).toContain('/**');
    // Not just any comment — the reasoning a caller needs at the call site.
    expect(declaration).toContain('matchParams');
  });

  it('keeps the core inside a CloudFront Function code budget', () => {
    const core = statSync(join(DIST, 'core', 'match.js')).size;
    const barrel = statSync(join(DIST, 'core', 'index.js')).size;
    const entry = statSync(join(DIST, 'index.js')).size;
    expect(core + barrel + entry).toBeLessThan(CLOUDFRONT_CODE_LIMIT_BYTES);
  });

  it('does not drag an adapter in behind the default entry point', () => {
    // The reason the adapters are separate subpaths at all: a CloudFront
    // Function importing the core must not pull in fetch, Contentful or Next.
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
        const target = join(file, '..', match[1]!.replace(/\.js$/, '.js'));
        if (existsSync(target)) walk(target);
      }
    };
    walk(join(DIST, 'index.js'));

    const reached = [...seen].map((f) => f.replace(DIST + '/', ''));
    expect(reached.sort()).toEqual(['core/index.js', 'core/match.js', 'index.js']);
  });
});

describeBuilt('the tarball', () => {
  it('contains the docs and no source maps of our internals', () => {
    // `--ignore-scripts`: a dry run still runs `prepack`, which cleans and
    // rebuilds `dist` — from inside a test, racing lage's own build of the
    // same directory. The listing is what is asserted; the build is ordered
    // ahead of this suite by lage (`#test` depends on `build`) and by CI.
    const listing = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8'
    });
    const files: string[] = JSON.parse(listing)[0].files.map((f: { path: string }) => f.path);

    // The README links SECURITY.md and the design notes, so both ship: a link
    // that resolves on GitHub and dangles on npm is the kind of gap a
    // customer's reviewer hits first.
    expect(files).toEqual(
      expect.arrayContaining(['README.md', 'LICENSE', 'package.json', 'SECURITY.md', 'docs/design-notes.md'])
    );
    expect(files.some((f) => f.startsWith('dist/'))).toBe(true);
    // Tests, configs and the source tree are not a customer's business.
    expect(files.filter((f) => f.endsWith('.test.js') || f.endsWith('.test.ts'))).toEqual([]);
    expect(files.filter((f) => f.startsWith('src/'))).toEqual([]);
    // A map without its sources only points the customer's editor at a file
    // they do not have.
    expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);
  });
});
