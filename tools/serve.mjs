// A small static server for previewing the site locally: node tools/serve.mjs [dir] [port]
// Defaults: dist/ on port 8080 (port 0 picks a free one). Sends a Date header, as GitHub Pages does,
// so the clock check runs. Also used by tests/smoke.mjs.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, resolve } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
};

/** Options: { sendDate: false } omits the Date header (browser tests run on a simulated clock). */
export function serve(dir, port = 0, { sendDate = true } = {}) {
  const root = resolve(dir);
  const server = createServer(async (req, res) => {
    res.sendDate = sendDate;
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(root, path));
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      const st = await stat(file);
      if (!st.isFile()) throw new Error('not a file');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ server, port: server.address().port })));
}

if (process.argv[1] && process.argv[1].endsWith('serve.mjs')) {
  const dir = process.argv[2] || 'dist';
  const { port } = await serve(dir, Number(process.argv[3] || 8080));
  console.log(`Serving ${dir} at http://127.0.0.1:${port}/  (Ctrl+C to stop)`);
}
