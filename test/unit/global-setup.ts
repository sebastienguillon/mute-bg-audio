// Vitest global setup: generates the test media (scripts/make-test-media.mjs) once, before the test
// files start in parallel workers, unless it is complete already. Without it, the first run on a
// fresh checkout would have several workers generate and read the same files at the same time.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export default function setup(): void {
  const script = join(import.meta.dirname, '../../scripts/make-test-media.mjs');
  // The script explains what is missing (it needs macOS `say` and ffmpeg) when it cannot run.
  execFileSync(process.execPath, [script, '--if-missing'], { stdio: 'inherit' });
}
