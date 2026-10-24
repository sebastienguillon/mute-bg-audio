// Minimal static server for the end-to-end tests. Serves test/e2e/site/ and the generated media
// under /media/ (with the e2e media of media.mjs under /media/e2e/). Chromium maps www.youtube.com,
// music.youtube.com and media.test (used as a cross-origin host) to it.
//
// Query parameters understood on every path:
//   ?cors=1   adds Access-Control-Allow-Origin: * (tests also serve tainted cross-origin media)
//   ?coep=1   serves the response with COEP require-corp + COOP same-origin (cross-origin isolated page)
// and one route:
//   /redirect?to=<url>   302 redirect to <url>
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureE2eMedia, generated } from './media.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const roots = { '/media/': generated, '/': join(here, 'site/') };
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webm': 'video/webm', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.json': 'application/json' };

/** Host names the certificate covers (Chromium also runs with --ignore-certificate-errors). */
const HOSTS = ['www.youtube.com', 'music.youtube.com', 'media.test'];

/** Self-signed certificate for the test hosts (youtube.com is HSTS-preloaded, so it needs HTTPS). */
function testCertificate() {
  const dir = join(generated, 'tls');
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem'), hosts = join(dir, 'hosts.txt');
  const want = HOSTS.join(',');
  if (!existsSync(key) || !existsSync(cert) || !existsSync(hosts) || readFileSync(hosts, 'utf8') !== want) {
    mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650', '-subj', `/CN=${HOSTS[0]}`,
      '-addext', `subjectAltName=${HOSTS.map((h) => `DNS:${h}`).join(',')}`, '-keyout', key, '-out', cert], { stdio: 'ignore' });
    writeFileSync(hosts, want);
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

export function startServer(port = 0, { https = true } = {}) {
  ensureE2eMedia();
  const handler = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: url.searchParams.get('to') ?? '/', 'Cache-Control': 'no-store' }).end();
      return;
    }
    const prefix = Object.keys(roots).find((p) => url.pathname.startsWith(p));
    const root = roots[prefix];
    const file = normalize(join(root, url.pathname.slice(prefix.length) || 'index.html'));
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    const size = statSync(file).size;
    const headers = { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (url.searchParams.get('cors') === '1') headers['Access-Control-Allow-Origin'] = '*';
    if (url.searchParams.get('coep') === '1') {
      headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
      headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    createReadStream(file).pipe(res);
  };
  const server = https ? createHttpsServer(testCertificate(), handler) : createHttpServer(handler);
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startServer(Number(process.argv[2] ?? 8123));
  console.log('listening on', s.address());
}
