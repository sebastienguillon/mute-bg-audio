// Extension messaging for content scripts that survives the extension going away.
//
// After the extension is reloaded, updated, disabled or uninstalled, the content scripts already
// in open pages keep running ("orphaned"), but every extension API call throws synchronously
// ('Extension context invalidated.') instead of returning a rejected promise.
import type { RuntimeMessage } from '@/lib/protocol';

/** False once this content script's extension context is gone (runtime.id is cleared then). */
export function extensionAlive(): boolean {
  try {
    return Boolean(browser.runtime?.id);
  } catch {
    return false;
  }
}

/** Whether an extension API error means the extension context is gone. */
export function isContextInvalidated(error: unknown): boolean {
  return /context invalidated/i.test(String(error)) || !extensionAlive();
}

/** browser.runtime.sendMessage that reports every failure, synchronous ones included, as a rejection. */
export function sendRuntime<R = unknown>(msg: RuntimeMessage): Promise<R> {
  try {
    return Promise.resolve(browser.runtime.sendMessage(msg) as Promise<R>);
  } catch (e) {
    return Promise.reject(e);
  }
}
