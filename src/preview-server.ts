import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

function resolveDefaultPreviewDir(): string {
  if (process.env.PREVIEW_DIR) {
    return path.resolve(process.env.PREVIEW_DIR);
  }

  const candidates = [
    // Group-local preview directory (writable by non-main containers)
    path.resolve(process.cwd(), 'groups', 'jambutter-project', '.data', 'preview'),
    // Legacy global preview directory
    path.resolve(process.cwd(), 'data', 'preview'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

const PREVIEW_DIR = resolveDefaultPreviewDir();
const ACTIVE_FILE = path.join(PREVIEW_DIR, '.active');
const PORT = parseInt(process.env.PREVIEW_PORT || '8080', 10);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

function getMime(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function serveFile(res: http.ServerResponse, filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    const mime = getMime(filePath);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': filePath.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

function listProjects(): string[] {
  try {
    return fs.readdirSync(PREVIEW_DIR).filter((f) => {
      if (f.startsWith('.')) return false;
      const p = path.join(PREVIEW_DIR, f);
      return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'index.html'));
    });
  } catch {
    return [];
  }
}

function getActiveProject(): string | null {
  // 1. Check .active file
  try {
    const name = fs.readFileSync(ACTIVE_FILE, 'utf-8').trim();
    const dir = path.join(PREVIEW_DIR, name);
    if (fs.existsSync(path.join(dir, 'index.html'))) return name;
  } catch { /* no .active file */ }

  // 2. Fall back to the only project if there's exactly one
  const projects = listProjects();
  if (projects.length === 1) return projects[0];

  return null;
}

function renderProjectList(): string {
  const projects = listProjects();
  const active = getActiveProject();
  const items = projects.length
    ? projects.map((p) => {
        const marker = p === active ? ' (active)' : '';
        return `<li><a href="/_set/${p}">${p}${marker}</a></li>`;
      }).join('\n      ')
    : '<li>No projects deployed yet</li>';
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NanoClaw Preview</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; color: #333; }
    h1 { font-size: 1.4em; }
    a { color: #0066cc; }
    li { margin: 8px 0; }
    .hint { color: #888; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>NanoClaw Preview Server</h1>
  <p>Click a project to set it as active and preview it:</p>
  <ul>
    ${items}
  </ul>
  <p class="hint">Active project is served at <a href="/">root /</a></p>
</body>
</html>`;
}

function getLocalIPs(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  return ips;
}

// Ensure preview directory exists
fs.mkdirSync(PREVIEW_DIR, { recursive: true });

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  // /_projects — show project listing
  if (pathname === '/_projects') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderProjectList());
    return;
  }

  // /_set/{name} — set active project and redirect to root
  if (pathname.startsWith('/_set/')) {
    const name = pathname.slice(6);
    const dir = path.join(PREVIEW_DIR, name);
    if (name && !name.includes('/') && !name.includes('..') && fs.existsSync(path.join(dir, 'index.html'))) {
      fs.writeFileSync(ACTIVE_FILE, name);
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`Project "${name}" not found`);
    return;
  }

  // Resolve active project
  const active = getActiveProject();

  // No active project — show listing
  if (!active) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderProjectList());
    return;
  }

  const projectDir = path.join(PREVIEW_DIR, active);

  // Serve from active project at root
  let filePath = path.join(projectDir, pathname);

  // Security: prevent path traversal
  if (!filePath.startsWith(projectDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // If path is a directory, try index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  // If file exists, serve it
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    serveFile(res, filePath);
    return;
  }

  // SPA fallback: serve index.html for any unmatched route
  const indexPath = path.join(projectDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    serveFile(res, indexPath);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  const active = getActiveProject();
  console.log(`Preview server running on port ${PORT}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const ip of ips) {
    console.log(`  Network: http://${ip}:${PORT}`);
  }
  console.log(`\nServing from: ${PREVIEW_DIR}`);
  console.log(`Active project: ${active || 'none (visit /_projects to set one)'}`);
});
