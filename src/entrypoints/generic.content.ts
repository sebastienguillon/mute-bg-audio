// Injected on demand (popup "Remove music on this tab", or sites the user chose to always run on).
import { startController } from '@/content/start';

export default defineContentScript({
  // Injected with chrome.scripting only: no manifest matches, so no install-time host permission.
  matches: [],
  registration: 'runtime',
  main(ctx) {
    startController(ctx, 'generic');
  },
});
