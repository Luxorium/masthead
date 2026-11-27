// Work folders of the live and browser tests: removed when everything passed, kept (with its path
// printed) when something failed, so a failure can still be looked at.
import { rmSync } from 'node:fs';

export function finishWorkFolder(dir: string, failed: boolean, log: (...a: unknown[]) => void = console.log): void {
  if (failed) {
    log('work folder kept for a look:', dir);
    return;
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    log(`could not remove the work folder ${dir}: ${(e as Error).message}`);
  }
}
