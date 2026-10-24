// Starts the page controller from a content script's main(ctx), or hands the running one over.
import { MediaController, type ScriptContext, type Site } from './controller';
import { isYouTubeHost } from './media';

/** Window slots (in the extension's isolated world, invisible to the page) holding each site's controller. */
const SLOTS: Readonly<Record<Site, string>> = { youtube: '__bgmrYouTube', generic: '__bgmrGeneric' };

/**
 * One controller per frame. Routing media is irreversible, so a second controller could not
 * process media the first one routed: a script injected again (the popup's "Remove music on this
 * tab" after an earlier injection; WXT invalidates the earlier context then) takes the running
 * controller over. The generic controller never starts in frames the YouTube controller covers.
 */
export function startController(ctx: ScriptContext, site: Site): MediaController | null {
  const slots = window as unknown as Partial<Record<string, MediaController>>;
  if (site === 'generic' && (isYouTubeHost(location.hostname) || slots[SLOTS.youtube])) return null;
  const running = slots[SLOTS[site]];
  if (running && !running.isShutDown) {
    running.attach(ctx);
    if (site === 'generic') running.setTabEnabled(true);
    return running;
  }
  const controller = new MediaController(site);
  slots[SLOTS[site]] = controller;
  controller.attach(ctx);
  void controller.init();
  return controller;
}
