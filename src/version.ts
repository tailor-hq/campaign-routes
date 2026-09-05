/**
 * The package version, as a constant the runtime can read. Kept equal to
 * `package.json` by `package-shape.test.ts`, since the edge runtimes this ships
 * to cannot read the file at runtime and a JSON import would land in the
 * bundle. The route handler stamps it on every payload, so whoever reads the
 * endpoint (Tailor included) can see which version a site runs.
 */
export const VERSION = '0.1.0';
