// Generated test media (test/fixtures/generated/). scripts/make-test-media.mjs makes the base set
// once, from the global setup (test/unit/global-setup.ts), before the test files start in parallel
// workers; the helpers cache what they derive from it with cached().
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * `path`, made first by `make(tmp)` if it does not exist. `make` writes the file or directory `tmp`
 * (same name, in a private directory next to `path`), which is then renamed into place: test files
 * running in parallel never read a partial result, and an interrupted run leaves none at `path`.
 */
export function cached(path: string, make: (tmp: string) => void): string {
  if (existsSync(path)) return path;
  mkdirSync(dirname(path), { recursive: true });
  const work = mkdtempSync(join(dirname(path), '.tmp-'));
  try {
    const tmp = join(work, basename(path));
    make(tmp);
    try {
      renameSync(tmp, path);
    } catch (e) {
      // Made by another test file meanwhile (a directory cannot be renamed over another one).
      if (!existsSync(path)) throw e;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return path;
}
