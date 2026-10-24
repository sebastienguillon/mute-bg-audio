// Loads the popup (bundled from source with esbuild) in Playwright's Chromium with a scripted
// fake extension API, so tests can drive it like a user and inspect the API calls it makes.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { build } from 'esbuild';
import type { TabStatus } from '../../../src/lib/protocol';
import type { Settings } from '../../../src/lib/settings';
import type { CommandResult } from '../../../src/lib/tab-status';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const POPUP_DIR = join(ROOT, 'src/entrypoints/popup');
const ORIGIN = 'http://popup.test';

export interface PopupScenario {
  /** URL of the active tab. */
  url: string;
  /** Answer to 'get-tab-status'. */
  status: TabStatus | null;
  settings?: Partial<Settings>;
  /** Whether a content script runs in the top frame (it answers tab commands with `status`). */
  contentScript?: boolean;
  /** Whether a subframe (e.g. a YouTube embed) runs a content script, answering with `subframeStatus`. */
  subframeScript?: boolean;
  subframeStatus?: TabStatus;
  /** Answer of the background to enable-on-tab / start-tab-capture / stop-tab-capture. */
  commandResult?: CommandResult;
  /** permissions.contains / permissions.request results. */
  granted?: boolean;
  grant?: boolean;
}

/** An extension API call recorded by the fake. */
export interface ApiCall {
  api: string;
  args: unknown[];
}

/** Bundles src/entrypoints/popup/main.ts for the browser (WXT's `browser` global stays free). */
export async function bundlePopup(): Promise<string> {
  const result = await build({
    entryPoints: [join(POPUP_DIR, 'main.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'wxt-alias',
        setup(b) {
          b.onResolve({ filter: /^@\// }, (args) => ({ path: join(ROOT, 'src', `${args.path.slice(2)}.ts`) }));
        },
      },
    ],
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error('esbuild produced no output');
  return file.text;
}

/** Opens the popup for a scenario and waits until the first tab status is shown. */
export async function openPopup(
  browser: Browser,
  bundle: string,
  scenario: PopupScenario,
  colorScheme: 'light' | 'dark' = 'light',
): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 320, height: 600 }, colorScheme });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/main.ts') return route.fulfill({ body: bundle, contentType: 'text/javascript' });
    if (path === '/icon/32.png') return route.fulfill({ body: await readFile(join(ROOT, 'public/icon/32.png')), contentType: 'image/png' });
    if (path === '/' || path === '/style.css') {
      const file = path === '/' ? 'index.html' : 'style.css';
      return route.fulfill({ body: await readFile(join(POPUP_DIR, file)), contentType: path === '/' ? 'text/html' : 'text/css' });
    }
    return route.fulfill({ status: 404 });
  });
  await page.addInitScript(installFakeBrowser, scenario);
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => document.getElementById('status-headline')?.textContent !== 'Checking this tab…');
  if (errors.length) throw new Error(errors.join('\n'));
  return page;
}

/** API calls made so far, optionally filtered by API name. */
export function calls(page: Page, api?: string): Promise<ApiCall[]> {
  return page.evaluate((api) => {
    const all = (window as unknown as { __calls: ApiCall[] }).__calls;
    return api ? all.filter((c) => c.api === api) : all;
  }, api);
}

/** Changes the fake's answers mid-test. */
export function updateScenario(page: Page, patch: Partial<PopupScenario>): Promise<void> {
  return page.evaluate((patch) => {
    Object.assign((window as unknown as { __scenario: PopupScenario }).__scenario, patch);
  }, patch);
}

/** Runs in the page before the popup script: defines `browser` from the scenario. */
function installFakeBrowser(scenario: PopupScenario): void {
  const w = window as unknown as { __calls: ApiCall[]; __scenario: PopupScenario; browser: unknown };
  w.__calls = [];
  w.__scenario = scenario;
  const record = (api: string, ...args: unknown[]) => w.__calls.push({ api, args: JSON.parse(JSON.stringify(args)) });
  const event = { addListener() {}, removeListener() {} };
  const commandTypes = ['enable-on-tab', 'start-tab-capture', 'stop-tab-capture'];
  w.browser = {
    runtime: {
      id: 'fake',
      async sendMessage(message: { type: string }) {
        record('runtime.sendMessage', message);
        if (message.type === 'get-tab-status') return w.__scenario.status;
        if (commandTypes.includes(message.type)) return w.__scenario.commandResult ?? { status: w.__scenario.status };
        return undefined;
      },
      onMessage: event,
    },
    tabs: {
      async query() {
        return [{ id: 7, url: w.__scenario.url }];
      },
      async sendMessage(tabId: number, message: unknown, options?: { frameId?: number }) {
        if (options) record('tabs.sendMessage', tabId, message, options);
        else record('tabs.sendMessage', tabId, message);
        const s = w.__scenario;
        // A broadcast resolves with the first answer; the subframe's comes first in this fake.
        if (options?.frameId === undefined && s.subframeScript) return s.subframeStatus ?? s.status;
        if ((options?.frameId ?? 0) === 0 && s.contentScript) return s.status;
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
    },
    storage: {
      local: {
        async get() {
          return { settings: w.__scenario.settings ?? {} };
        },
        async set(items: unknown) {
          record('storage.local.set', items);
        },
      },
      onChanged: event,
    },
    permissions: {
      async contains(p: unknown) {
        record('permissions.contains', p);
        return !!w.__scenario.granted;
      },
      async request(p: unknown) {
        record('permissions.request', p);
        return !!w.__scenario.grant;
      },
      async remove(p: unknown) {
        record('permissions.remove', p);
        return true;
      },
    },
  };
}
