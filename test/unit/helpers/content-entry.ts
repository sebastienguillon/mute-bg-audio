// Page-side entry of the content-script test bundle (see content-harness.ts).
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import { MediaController, type ControllerTiming, type Site } from '../../../src/content/controller';
import { canTap } from '../../../src/content/media';
import { startController } from '../../../src/content/start';

const api = {
  canTap,
  startController,
  /** A new WXT context, as a (re-)injected content script gets one. */
  context: (name = 'content-test') => new ContentScriptContext(name),
  start(site: Site, timing: Partial<ControllerTiming>): MediaController {
    const controller = new MediaController(site, timing);
    controller.attach(new ContentScriptContext('content-test'));
    void controller.init();
    (window as unknown as { __controller: MediaController }).__controller = controller;
    return controller;
  },
};

(window as unknown as { __content: typeof api }).__content = api;
