const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const FPL_API_BASE = 'https://fantasy.premierleague.com/api';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function proxyFplApi(req, res, pathname, search, redirectCount = 0) {
  const targetPath = pathname.replace(/^\/api/, '') || '/';
  const targetUrl = FPL_API_BASE + targetPath + (search || '');

  const options = {
    method: req.method,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) fantazi-app-proxy/1.0',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://fantasy.premierleague.com/'
    }
  };

  console.log(`[proxy] ${req.method} ${pathname}${search || ''} -> ${targetUrl}`);

  const proxyReq = https.request(targetUrl, options, (proxyRes) => {
    const status = proxyRes.statusCode || 502;
    const location = proxyRes.headers.location;

    // Follow redirects (limited)
    if ([301, 302, 303, 307, 308].includes(status) && location && redirectCount < 5) {
      proxyRes.resume();
      try {
        const redirected = new URL(location, targetUrl);
        if (redirected.origin + redirected.pathname.startsWith(FPL_API_BASE)) {
          const newPath = '/api' + redirected.pathname.replace(/^\/api/, '');
          return proxyFplApi(req, res, newPath, redirected.search, redirectCount + 1);
        }
      } catch (_) {}
      return send(res, 502, JSON.stringify({ error: 'Proxy redirect error', location }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
    }

    const chunks = [];
    proxyRes.on('data', (chunk) => chunks.push(chunk));
    proxyRes.on('end', () => {
      const body = Buffer.concat(chunks);
      if (status >= 400) {
        console.error(`[proxy] upstream error ${status} for ${targetUrl}`);
      }
      res.writeHead(status, {
        'Content-Type': proxyRes.headers['content-type'] || 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      });
      res.end(body);
    });
  });

  proxyReq.on('error', (err) => {
    console.error(`[proxy] request error for ${targetUrl}:`, err.message);
    send(res, 502, JSON.stringify({
      error: 'Proxy request failed',
      message: err.message,
      code: err.code || null,
      hint: 'Check internet/firewall/VPN access to fantasy.premierleague.com from this machine.'
    }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
  });

  proxyReq.setTimeout(20000, () => {
    proxyReq.destroy(new Error('Upstream timeout'));
  });

  proxyReq.end();
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = decodeURIComponent(filePath);
  const resolved = path.join(ROOT, filePath);

  if (!resolved.startsWith(ROOT)) {
    return send(res, 403, 'Forbidden');
  }

  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) {
      return send(res, 404, 'Not Found');
    }
    const ext = path.extname(resolved).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(resolved).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }

    if (pathname.startsWith('/api/')) {
      return proxyFplApi(req, res, pathname, parsed.search);
    }

    return serveStatic(req, res, pathname);
  } catch (e) {
    return send(res, 500, 'Server error');
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`FPL API proxy available at http://localhost:${PORT}/api/...`);
});
