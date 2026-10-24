import { startController } from '@/content/start';

export default defineContentScript({
  matches: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'],
  runAt: 'document_start',
  allFrames: true,
  main(ctx) {
    startController(ctx, 'youtube');
  },
});
