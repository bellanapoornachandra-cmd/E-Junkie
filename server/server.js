import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DB_PATH, SetupError } from './db.js';
import { createApi, HttpError } from './app.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = 100 * 1024;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'",
};

function openOrExit() {
  try {
    // ADMIN_EMAIL / ADMIN_PASSWORD come from .env and are only used to create the first admin.
    return openDb(DB_PATH, { admin: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } });
  } catch (e) {
    if (!(e instanceof SetupError)) throw e;
    console.error(`Setup error: ${e.message}`);
    process.exit(1);
  }
}

const handle = createApi(openOrExit());

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(url, res) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, SECURITY_HEADERS).end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(url, res);
  try {
    if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
      // Forces a CORS preflight for cross-site requests, which we never approve.
      throw new HttpError(415, 'Send requests as JSON.');
    }
    const body = req.method === 'GET' ? {} : await readBody(req);
    const result = await handle(req, url, body);
    const headers = { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    let payload = result;
    if (result && result.$cookie) {
      headers['Set-Cookie'] = result.$cookie;
      const { $cookie, ...rest } = result;
      payload = rest;
    }
    res.writeHead(200, headers).end(JSON.stringify(payload ?? null));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
      .end(JSON.stringify({ error: status === 500 ? 'Something went wrong on our side. Please try again.' : err.message, ...(err.code ? { code: err.code } : {}) }));
  }
});

server.listen(PORT, () => console.log(`E-Junkie running at http://localhost:${PORT}`));
