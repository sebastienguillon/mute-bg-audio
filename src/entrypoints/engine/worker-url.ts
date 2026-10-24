// Module worker URLs for extension pages. In builds a worker chunk is part of the extension; with
// `pnpm dev` Vite serves it from its dev server, and a chrome-extension:// page cannot start a
// worker from another origin (Chrome even crashes the renderer). There a same-origin blob module
// imports the worker script instead (module imports are CORS requests, which the dev server
// allows).

/**
 * URL to start a `{ type: 'module' }` worker from: `url` (a `?worker&url` import) resolved
 * against `base` (the importing module's URL) when it has this page's origin, else a blob URL
 * of a module that imports it (revoked once the worker loaded it).
 */
export function workerUrl(url: string, base: string): string {
  const resolved = new URL(url, base);
  // (Compared by prefix: URL.origin is 'null' for chrome-extension: URLs outside Chrome.)
  if (resolved.href.startsWith(`${location.origin}/`)) return resolved.href;
  const shim = `import ${JSON.stringify(resolved.href)};\nURL.revokeObjectURL(import.meta.url);\n`;
  return URL.createObjectURL(new Blob([shim], { type: 'text/javascript' }));
}
