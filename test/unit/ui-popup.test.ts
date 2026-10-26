// Drives the real popup script in Chromium against a fake extension API.
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TabStatus } from '../../src/lib/protocol';
import { bundlePopup, calls, openPopup, updateScenario, type PopupScenario } from './helpers/ui-popup-harness';

const YOUTUBE = 'https://www.youtube.com/watch?v=abc';
const VIMEO = 'https://vimeo.com/123';
const lookahead: TabStatus = {
  mode: 'lookahead',
  site: 'youtube',
  enabled: true,
  latencyMs: 60,
  lookahead: { state: 'ready', backend: 'webgpu', aheadSeconds: 24.2 },
};

let browser: Browser;
let bundle: string;
let page: Page | null = null;

beforeAll(async () => {
  [browser, bundle] = await Promise.all([chromium.launch(), bundlePopup()]);
});

afterAll(async () => {
  await browser?.close();
});

afterEach(async () => {
  await page?.context().close();
  page = null;
});

async function open(scenario: PopupScenario): Promise<Page> {
  page = await openPopup(browser, bundle, scenario);
  return page;
}

const text = (p: Page, id: string) => p.locator(`#${id}`).innerText();

describe('popup', () => {
  it('shows the YouTube look-ahead status and the stored settings', async () => {
    const p = await open({ url: YOUTUBE, status: lookahead, contentScript: true, settings: { reductionDb: 24, quality: 'realtime', gapReduction: false } });
    expect(await p.locator('#status').innerText()).toContain('Look-ahead · GPU · 24 s ready');
    expect(await text(p, 'status-latency')).toBe('Latency 60 ms');
    expect(await p.getByRole('switch', { name: 'Remove music on this tab' }).isChecked()).toBe(true);
    expect(await p.locator('#capture').isHidden()).toBe(true);
    expect(await p.locator('#auto-row').isHidden()).toBe(true);
    expect(await text(p, 'reduction-value')).toBe('24 dB');
    expect(await p.getByLabel('Music reduction').getAttribute('aria-valuetext')).toBe('24 dB');
    expect(await p.getByLabel('Quality').inputValue()).toBe('realtime');
    expect(await p.getByLabel('Extra reduction between sentences').isChecked()).toBe(false);
    expect(await p.getByRole('switch', { name: 'Extension enabled' }).isChecked()).toBe(true);
    // The live region never announces the fast-changing counter.
    expect(await p.locator('#status-progress').getAttribute('aria-hidden')).toBe('true');
  });

  it('sends tab commands to a running content script', async () => {
    const p = await open({ url: YOUTUBE, status: lookahead, contentScript: true });
    await updateScenario(p, { status: { ...lookahead, mode: 'off', enabled: false } });
    await p.getByRole('switch', { name: 'Remove music on this tab' }).click();
    await expect.poll(() => text(p, 'status-headline')).toBe('Off on this tab');
    expect((await calls(p, 'tabs.sendMessage')).map((c) => c.args)).toEqual([[7, { type: 'tab-command', command: 'disable' }]]);
    expect(await p.getByRole('switch', { name: 'Remove music on this tab' }).isChecked()).toBe(false);
    // Remembered for the tab: it stays off when the page reloads.
    expect((await calls(p, 'runtime.sendMessage')).map((c) => c.args[0])).toContainEqual({ type: 'set-tab-enabled', tabId: 7, enabled: false });
  });

  it("remembers the tab's switch before switching the frames on", async () => {
    const p = await open({ url: YOUTUBE, status: { mode: 'off', site: 'youtube', enabled: false }, contentScript: true });
    await updateScenario(p, { status: { mode: 'waiting', site: 'youtube', enabled: true } });
    await p.getByRole('switch', { name: 'Remove music on this tab' }).click();
    await expect.poll(() => text(p, 'status-headline')).toBe('Waiting for the video to play');
    const all = await calls(p);
    const remembered = all.findIndex((c) => c.api === 'runtime.sendMessage' && (c.args[0] as { type: string }).type === 'set-tab-enabled');
    const command = all.findIndex((c) => c.api === 'tabs.sendMessage');
    expect(all[remembered]?.args[0]).toEqual({ type: 'set-tab-enabled', tabId: 7, enabled: true });
    expect(remembered).toBeLessThan(command);
  });

  it("switches the tab back off when nothing could start on the page", async () => {
    const p = await open({ url: VIMEO, status: null, commandResult: { status: null, error: "Chrome doesn't allow extensions on this page." } });
    await p.getByRole('switch', { name: 'Remove music on this tab' }).click();
    await expect.poll(() => text(p, 'status-detail')).toBe("Chrome doesn't allow extensions on this page.");
    const switches = (await calls(p, 'runtime.sendMessage')).map((c) => c.args[0] as { type: string; enabled?: boolean }).filter((m) => m.type === 'set-tab-enabled');
    expect(switches.map((m) => m.enabled)).toEqual([true, false]);
    expect(await p.getByRole('switch', { name: 'Remove music on this tab' }).isChecked()).toBe(false);
  });

  it('asks the top frame first and re-enables the subframes along with it', async () => {
    const p = await open({ url: VIMEO, status: { mode: 'off', site: 'generic', enabled: false }, contentScript: true, subframeScript: true });
    await updateScenario(p, { status: { mode: 'waiting', site: 'generic', enabled: true } });
    await p.getByRole('switch', { name: 'Remove music on this tab' }).click();
    await expect.poll(() => text(p, 'status-headline')).toBe('Waiting for the video to play');
    const enable = { type: 'tab-command', command: 'enable' };
    expect((await calls(p, 'tabs.sendMessage')).map((c) => c.args)).toEqual([
      [7, enable, { frameId: 0 }],
      [7, enable],
    ]);
    const sent = (await calls(p, 'runtime.sendMessage')).map((c) => (c.args[0] as { type: string }).type);
    expect(sent).not.toContain('enable-on-tab');
  });

  it('injects the generic script when only an embed answers (no controller in the page itself)', async () => {
    const embed: TabStatus = { mode: 'off', site: 'youtube', enabled: false };
    const realtime: TabStatus = { mode: 'realtime', site: 'generic', enabled: true, latencyMs: 60 };
    const p = await open({ url: VIMEO, status: embed, subframeScript: true, commandResult: { status: realtime } });
    await p.getByRole('switch', { name: 'Remove music on this tab' }).click();
    await expect.poll(async () => (await calls(p, 'runtime.sendMessage')).map((c) => c.args[0])).toContainEqual({ type: 'enable-on-tab', tabId: 7 });
    expect((await calls(p, 'tabs.sendMessage')).map((c) => c.args)).toEqual([[7, { type: 'tab-command', command: 'enable' }, { frameId: 0 }]]);
    await expect.poll(() => text(p, 'status-headline')).toBe('Real-time · CPU');
  });

  it('broadcasts disable to every frame', async () => {
    const p = await open({ url: VIMEO, status: { mode: 'realtime', site: 'generic', enabled: true }, contentScript: true, subframeScript: true });
    await p.getByRole('switch', { name: 'Remove music on this tab' }).click();
    await expect.poll(async () => (await calls(p, 'tabs.sendMessage')).map((c) => c.args)).toEqual([[7, { type: 'tab-command', command: 'disable' }]]);
  });

  it('injects the generic script when no content script runs yet', async () => {
    const realtime: TabStatus = { mode: 'realtime', site: 'generic', enabled: true, latencyMs: 60 };
    const p = await open({ url: VIMEO, status: null, commandResult: { status: realtime } });
    expect(await text(p, 'status-headline')).toBe('Off on this page');
    expect(await p.locator('#capture').isVisible()).toBe(true);
    await updateScenario(p, { status: realtime }); // What the background reports once injected.
    await p.getByRole('switch', { name: 'Remove music on this tab' }).press('Space');
    await expect.poll(() => text(p, 'status-headline')).toBe('Real-time · CPU');
    const sent = (await calls(p, 'runtime.sendMessage')).map((c) => c.args[0]);
    expect(sent).toContainEqual({ type: 'enable-on-tab', tabId: 7 });
  });

  it('asks YouTube tabs without a controller to reload', async () => {
    const p = await open({ url: YOUTUBE, status: null });
    expect(await text(p, 'status-headline')).toBe('Not running on this tab yet');
    await p.getByRole('switch', { name: 'Remove music on this tab' }).click();
    await expect.poll(() => text(p, 'status-detail')).toBe('Reload the page to start.');
    const sent = (await calls(p, 'runtime.sendMessage')).map((c) => c.args[0] as { type: string });
    expect(sent.map((m) => m.type)).not.toContain('enable-on-tab');
    // The reloaded page starts on.
    expect(sent).toContainEqual({ type: 'set-tab-enabled', tabId: 7, enabled: true });
  });

  it('starts tab capture for protected media and shows capture errors', async () => {
    const drm: TabStatus = { mode: 'unsupported', site: 'generic', enabled: true, needsTabCapture: true, detail: 'DRM-protected.' };
    const p = await open({
      url: VIMEO,
      status: drm,
      contentScript: true,
      commandResult: { status: drm, error: 'This tab is already being captured.' },
    });
    const button = p.getByRole('button', { name: 'Use tab capture instead' });
    expect(await button.getAttribute('class')).toContain('primary');
    expect(await p.getByText('Chrome will show its sharing indicator.').isVisible()).toBe(true);
    await button.click();
    await expect.poll(() => text(p, 'status-detail')).toBe('This tab is already being captured.');
    const sent = (await calls(p, 'runtime.sendMessage')).map((c) => c.args[0]);
    expect(sent).toContainEqual({ type: 'start-tab-capture', tabId: 7 });
  });

  it('makes tab capture the primary action when the video plays in a cross-origin frame', async () => {
    const framed: TabStatus = {
      mode: 'unsupported',
      site: 'generic',
      enabled: true,
      needsTabCapture: true,
      detail: 'The video plays in a frame from player.vimeo.com.',
    };
    const p = await open({ url: 'https://news.example/article', status: framed, contentScript: true });
    expect(await text(p, 'status-headline')).toBe("Can't process this video directly");
    expect(await text(p, 'status-detail')).toBe('The video plays in a frame from player.vimeo.com.');
    expect(await p.getByRole('button', { name: 'Use tab capture instead' }).getAttribute('class')).toContain('primary');
  });

  it('does not suggest tab capture for routed media that only a reload brings back', async () => {
    const detail = 'The sound of this media cannot be read any more. Reload the page to hear it; tab capture can then process it.';
    const silenced: TabStatus = { mode: 'unsupported', site: 'generic', enabled: true, detail };
    const p = await open({ url: VIMEO, status: silenced, contentScript: true });
    expect(await text(p, 'status-headline')).toBe("Can't process this video directly");
    expect(await text(p, 'status-detail')).toBe(detail);
    expect(await p.locator('#capture').isHidden()).toBe(true);
  });

  it('shows a paused video and in-page processing standing down for tab capture', async () => {
    const p = await open({ url: YOUTUBE, status: { ...lookahead, mode: 'waiting', detail: 'Paused.' }, contentScript: true });
    expect(await text(p, 'status-headline')).toBe('Paused');
    expect(await p.locator('#status-detail').isHidden()).toBe(true);
    expect(await p.locator('#status-latency').isHidden()).toBe(true);
    await updateScenario(p, { status: { mode: 'off', site: 'youtube', enabled: false, detail: 'Tab capture is processing this tab.' } });
    await expect.poll(() => text(p, 'status-detail'), { timeout: 2500 }).toBe('Tab capture is processing this tab.');
    expect(await text(p, 'status-headline')).toBe('Off on this tab');
  });

  it('links the third-party licenses from the footer', async () => {
    const p = await open({ url: YOUTUBE, status: lookahead, contentScript: true });
    const link = p.getByRole('link', { name: 'Licenses' });
    expect(await link.getAttribute('href')).toBe('/THIRD_PARTY_NOTICES.txt');
    expect(await link.getAttribute('target')).toBe('_blank');
  });

  it('stops tab capture from the button and from the main toggle', async () => {
    const capturing: TabStatus = { mode: 'tabcapture', site: 'tabcapture', enabled: true, latencyMs: 60 };
    const p = await open({ url: VIMEO, status: capturing, commandResult: { status: null } });
    expect(await text(p, 'status-headline')).toBe('Tab capture · Real-time · CPU');
    await p.getByRole('button', { name: 'Stop tab capture' }).click();
    await expect.poll(async () => (await calls(p, 'runtime.sendMessage')).some((c) => (c.args[0] as { type: string }).type === 'stop-tab-capture')).toBe(true);

    await updateScenario(p, { status: capturing });
    // Picked up by the next 1 s status poll.
    await expect.poll(() => text(p, 'status-headline'), { timeout: 2500 }).toBe('Tab capture · Real-time · CPU');
    await p.getByRole('switch', { name: 'Remove music on this tab' }).click();
    await expect
      .poll(async () => (await calls(p, 'runtime.sendMessage')).filter((c) => (c.args[0] as { type: string }).type === 'stop-tab-capture').length)
      .toBe(2);
  });

  it('debounces slider changes into one settings write', async () => {
    const p = await open({ url: YOUTUBE, status: lookahead, contentScript: true });
    const slider = p.getByLabel('Music reduction');
    await slider.focus();
    await slider.press('ArrowRight');
    await slider.press('ArrowRight');
    await slider.press('ArrowRight');
    expect(await text(p, 'reduction-value')).toBe('30 dB');
    await p.waitForTimeout(400);
    const writes = await calls(p, 'storage.local.set');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.args[0]).toMatchObject({ settings: { reductionDb: 30 } });
    await slider.press('End');
    expect(await text(p, 'reduction-value')).toBe('Remove');
    expect(await slider.getAttribute('aria-valuetext')).toBe('Remove');
  });

  it('saves the checkbox, quality and master switch immediately', async () => {
    const p = await open({ url: YOUTUBE, status: lookahead, contentScript: true });
    await p.getByLabel('Extra reduction between sentences').click();
    await p.getByLabel('Quality').selectOption('realtime');
    await p.getByRole('switch', { name: 'Extension enabled' }).click();
    const writes = (await calls(p, 'storage.local.set')).map((c) => (c.args[0] as { settings: Record<string, unknown> }).settings);
    expect(writes).toHaveLength(3);
    expect(writes[2]).toMatchObject({ gapReduction: false, quality: 'realtime', enabled: false });
    expect(await text(p, 'status-headline')).toBe('Turned off on all sites');
    expect(await p.getByRole('switch', { name: 'Remove music on this tab' }).isDisabled()).toBe(true);
  });

  it('adds an auto site after the permission is granted and enables the tab', async () => {
    const p = await open({ url: VIMEO, status: null, granted: false, grant: true });
    const box = p.getByLabel('Always run on vimeo.com');
    expect(await box.isChecked()).toBe(false);
    await box.check();
    await expect.poll(async () => (await calls(p, 'runtime.sendMessage')).some((c) => (c.args[0] as { type: string }).type === 'enable-on-tab')).toBe(true);
    expect((await calls(p, 'permissions.request'))[0]!.args[0]).toEqual({ origins: ['https://vimeo.com/*'] });
    const writes = (await calls(p, 'storage.local.set')).map((c) => (c.args[0] as { settings: { autoSites: string[] } }).settings.autoSites);
    expect(writes.at(-1)).toEqual(['https://vimeo.com']);
    expect(await box.isChecked()).toBe(true);

    await box.uncheck();
    await expect.poll(async () => (await calls(p, 'permissions.remove')).length).toBe(1);
    const last = (await calls(p, 'storage.local.set')).at(-1)!.args[0] as { settings: { autoSites: string[] } };
    expect(last.settings.autoSites).toEqual([]);
  });

  it('drops the auto site again when the permission is denied', async () => {
    const p = await open({ url: VIMEO, status: null, granted: false, grant: false });
    // click(), not check(): the fake denies instantly, so the box ends up unchecked again.
    await p.getByLabel('Always run on vimeo.com').click();
    await expect.poll(async () => (await calls(p, 'storage.local.set')).length).toBe(2);
    const writes = (await calls(p, 'storage.local.set')).map((c) => (c.args[0] as { settings: { autoSites: string[] } }).settings.autoSites);
    expect(writes).toEqual([['https://vimeo.com'], []]);
    expect(await p.getByLabel('Always run on vimeo.com').isChecked()).toBe(false);
  });

  it('disables tab controls on pages Chrome does not let extensions touch', async () => {
    const p = await open({ url: 'chrome://extensions', status: null });
    expect(await text(p, 'status-headline')).toBe("Chrome doesn't allow extensions on this page");
    expect(await p.getByRole('switch', { name: 'Remove music on this tab' }).isDisabled()).toBe(true);
    expect(await p.locator('#capture').isHidden()).toBe(true);
    expect(await p.locator('#auto-row').isHidden()).toBe(true);
  });

  it('polls the tab status every second', async () => {
    const p = await open({ url: YOUTUBE, status: lookahead, contentScript: true });
    await updateScenario(p, { status: { ...lookahead, mode: 'realtime', lookahead: { state: 'loading' } } });
    await expect.poll(() => text(p, 'status-headline'), { timeout: 2500 }).toBe('Real-time · CPU');
    expect(await text(p, 'status-detail')).toBe('Preparing the GPU look-ahead model…');
  });
});
