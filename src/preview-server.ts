import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PROJECT_PREFIX = '/p';
const PROJECT_COOKIE = 'nanoclaw_preview_project';

const CWD = process.cwd();
const GLOBAL_PREVIEW_DIR = path.resolve(CWD, 'data', 'preview');
const ACTIVE_FILE = path.join(GLOBAL_PREVIEW_DIR, '.active');
const PORT = parseInt(process.env.PREVIEW_PORT || '8080', 10);

type ProjectEntry = {
  id: string;
  group: string;
  project: string;
  dir: string;
  root: string;
};

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

function isValidName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

function getGroupLabelFromRoot(root: string): string {
  const normalized = root.split(path.sep).join('/');
  const match = normalized.match(/\/groups\/([^/]+)\/\.data\/preview$/);
  if (match) return match[1];
  if (normalized.endsWith('/data/preview')) return 'global';
  return path.basename(path.dirname(root));
}

function makeProjectId(group: string, project: string): string {
  return `${group}--${project}`;
}

function parseProjectId(id: string): { group: string; project: string } | null {
  const sep = id.indexOf('--');
  if (sep <= 0) return null;
  const group = id.slice(0, sep);
  const project = id.slice(sep + 2);
  if (!isValidName(group) || !isValidName(project)) return null;
  return { group, project };
}

function resolvePreviewRoots(): string[] {
  if (process.env.PREVIEW_DIR) return [path.resolve(process.env.PREVIEW_DIR)];

  const roots: string[] = [];
  const groupsDir = path.resolve(CWD, 'groups');
  if (fs.existsSync(groupsDir) && fs.statSync(groupsDir).isDirectory()) {
    for (const group of fs.readdirSync(groupsDir)) {
      if (!isValidName(group)) continue;
      const candidate = path.join(groupsDir, group, '.data', 'preview');
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        roots.push(candidate);
      }
    }
  }

  roots.push(GLOBAL_PREVIEW_DIR);
  return Array.from(new Set(roots.map((r) => path.resolve(r))));
}

const PREVIEW_ROOTS = resolvePreviewRoots();

function listProjects(): ProjectEntry[] {
  const out: ProjectEntry[] = [];

  for (const root of PREVIEW_ROOTS) {
    if (!fs.existsSync(root)) continue;
    const group = getGroupLabelFromRoot(root);

    for (const entry of fs.readdirSync(root)) {
      if (!isValidName(entry)) continue;
      const dir = path.join(root, entry);
      if (!fs.existsSync(path.join(dir, 'index.html'))) continue;
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      out.push({
        id: makeProjectId(group, entry),
        group,
        project: entry,
        dir,
        root,
      });
    }
  }

  const projectNamesWithScopedCopy = new Set(
    out.filter((p) => p.group !== 'global').map((p) => p.project),
  );
  const deduped = out.filter(
    (p) => !(p.group === 'global' && projectNamesWithScopedCopy.has(p.project)),
  );

  return deduped.sort((a, b) => a.id.localeCompare(b.id));
}

function readCookie(header: string | undefined, key: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === key) return decodeURIComponent(v.join('='));
  }
  return null;
}

function findProjectById(projectId: string): ProjectEntry | null {
  return listProjects().find((p) => p.id === projectId) || null;
}

function findProjectByShortName(shortName: string): ProjectEntry | null {
  const projects = listProjects().filter((p) => p.project === shortName);
  return projects.length === 1 ? projects[0] : null;
}

function findProjectByGroupAndProject(group: string, project: string): ProjectEntry | null {
  if (!isValidName(group) || !isValidName(project)) return null;
  return findProjectById(makeProjectId(group, project));
}

function getActiveProject(): ProjectEntry | null {
  const projects = listProjects();
  if (projects.length === 0) return null;

  try {
    const raw = fs.readFileSync(ACTIVE_FILE, 'utf-8').trim();
    if (parseProjectId(raw)) {
      const entry = projects.find((p) => p.id === raw);
      if (entry) return entry;
    }
  } catch {
    // no global active file
  }

  for (const root of PREVIEW_ROOTS) {
    try {
      const projectName = fs.readFileSync(path.join(root, '.active'), 'utf-8').trim();
      if (!isValidName(projectName)) continue;
      const group = getGroupLabelFromRoot(root);
      const entry = projects.find((p) => p.id === makeProjectId(group, projectName));
      if (entry) return entry;
    } catch {
      // ignore
    }
  }

  if (projects.length === 1) return projects[0];
  return null;
}

function findProjectByAlias(alias: string): ProjectEntry | null {
  const byId = findProjectById(alias);
  if (byId) return byId;

  const byName = findProjectByShortName(alias);
  if (byName) return byName;

  const active = getActiveProject();
  if (active && active.project === alias) return active;

  return null;
}

function setActiveProject(entry: ProjectEntry): void {
  fs.mkdirSync(path.dirname(ACTIVE_FILE), { recursive: true });
  fs.writeFileSync(ACTIVE_FILE, entry.id);
  fs.writeFileSync(path.join(entry.root, '.active'), entry.project);
}

function projectFromReferer(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    const u = new URL(referer);
    const pathname = decodeURIComponent(u.pathname);

    if (pathname.startsWith(`${PROJECT_PREFIX}/`)) {
      const rest = pathname.slice(PROJECT_PREFIX.length + 1);
      const slashIndex = rest.indexOf('/');
      const projectId = slashIndex >= 0 ? rest.slice(0, slashIndex) : rest;
      return findProjectByAlias(projectId)?.id || null;
    }

    const rest = pathname.startsWith('/') ? pathname.slice(1) : pathname;
    const parts = rest.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const group = decodeURIComponent(parts[0]);
      const project = decodeURIComponent(parts[1]);
      const entry = findProjectByGroupAndProject(group, project);
      if (entry) return entry.id;
    }
    if (parts.length >= 1) {
      const alias = decodeURIComponent(parts[0]);
      const entry = findProjectByAlias(alias);
      if (entry) return entry.id;
    }

    return null;
  } catch {
    return null;
  }
}

function inferProject(req: http.IncomingMessage): ProjectEntry | null {
  const cookieProjectId = readCookie(req.headers.cookie, PROJECT_COOKIE);
  if (cookieProjectId) {
    const byCookie = findProjectById(cookieProjectId);
    if (byCookie) return byCookie;
  }

  const refererProjectId = projectFromReferer(req.headers.referer);
  if (refererProjectId) {
    const byReferer = findProjectById(refererProjectId);
    if (byReferer) return byReferer;
  }

  return getActiveProject();
}

function renderProjectList(): string {
  const projects = listProjects();
  const active = getActiveProject();

  const items = projects.length
    ? projects
        .map((p) => {
          const marker = active?.id === p.id ? ' (active)' : '';
          return `<li><a href="/${encodeURIComponent(p.group)}/${encodeURIComponent(p.project)}/">${p.group}/${p.project}${marker}</a> · <a href="/_set/${encodeURIComponent(p.id)}">set active</a></li>`;
        })
        .join('\n      ')
    : '<li>No projects deployed yet</li>';

  const activeHint = active
    ? `<p class="hint">Active project: <a href="/${encodeURIComponent(active.group)}/${encodeURIComponent(active.project)}/">${active.group}/${active.project}</a></p>`
    : '<p class="hint">No active project selected.</p>';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NanoClaw Preview</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 780px; margin: 60px auto; padding: 0 20px; color: #333; }
    h1 { font-size: 1.4em; }
    a { color: #0066cc; }
    li { margin: 10px 0; }
    code { background: #f6f6f6; padding: 2px 5px; border-radius: 4px; }
    .hint { color: #666; font-size: 0.92em; }
  </style>
</head>
<body>
  <h1>NanoClaw Preview Server</h1>
  <p>Projects are served under <code>/&lt;project&gt;/</code> or <code>/&lt;group&gt;/&lt;project&gt;/</code>.</p>
  <ul>
    ${items}
  </ul>
  ${activeHint}
</body>
</html>`;
}

function getLocalIPs(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
    }
  }
  return ips;
}

function serveFile(res: http.ServerResponse, filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    const mime = getMime(filePath);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': filePath.includes('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeMountPath(mountPath: string): string {
  if (!mountPath || mountPath === '/') return '/';
  const clean = mountPath.startsWith('/') ? mountPath : `/${mountPath}`;
  return clean.endsWith('/') ? clean.slice(0, -1) : clean;
}

function rewriteIndexForMount(rawHtml: string, mountPath: string): string {
  const mount = normalizeMountPath(mountPath);
  if (mount === '/') return rawHtml;

  // Only patch router basename. Keep asset URLs at root (/assets/...) so all
  // runtime modules resolve from one consistent URL space.
  return rawHtml.replace(/"basename":"\/"/g, `"basename":"${mount}"`);
}

function serveIndexHtml(res: http.ServerResponse, indexPath: string, mountPath: string): void {
  try {
    const raw = fs.readFileSync(indexPath, 'utf-8');
    const content = rewriteIndexForMount(raw, mountPath);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

function rewriteManifestJsForMount(rawJs: string, mountPath: string): string {
  const mount = normalizeMountPath(mountPath);
  if (mount === '/') return rawJs;
  return rawJs.replace(/"\/assets\//g, `"${mount}/assets/`);
}

function serveManifestJs(res: http.ServerResponse, filePath: string, mountPath: string): void {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const content = rewriteManifestJsForMount(raw, mountPath);
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

function serveProjectPath(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  entry: ProjectEntry,
  requestedPath: string,
  mountPath: string = '/',
): void {
  const projectDir = entry.dir;

  if (req.url?.startsWith('/') && !req.url.startsWith('/_')) {
    res.setHeader(
      'Set-Cookie',
      `${PROJECT_COOKIE}=${encodeURIComponent(entry.id)}; Path=/; Max-Age=604800; SameSite=Lax`,
    );
  }

  const relative = requestedPath === '/' ? '/index.html' : requestedPath;
  let filePath = path.join(projectDir, relative);

  if (!filePath.startsWith(projectDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    if (path.basename(filePath) === 'index.html') {
      serveIndexHtml(res, filePath, mountPath);
      return;
    }
    if (
      path.extname(filePath) === '.js' &&
      path.basename(path.dirname(filePath)) === 'assets' &&
      path.basename(filePath).startsWith('manifest-')
    ) {
      serveManifestJs(res, filePath, mountPath);
      return;
    }
    serveFile(res, filePath);
    return;
  }

  const indexPath = path.join(projectDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    serveIndexHtml(res, indexPath, mountPath);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

function setProjectSession(res: http.ServerResponse, entry: ProjectEntry): void {
  setActiveProject(entry);
  res.setHeader(
    'Set-Cookie',
    `${PROJECT_COOKIE}=${encodeURIComponent(entry.id)}; Path=/; Max-Age=604800; SameSite=Lax`,
  );
}

fs.mkdirSync(GLOBAL_PREVIEW_DIR, { recursive: true });

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/' || pathname === '/_projects') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderProjectList());
    return;
  }

  if (pathname === '/_active') {
    const active = getActiveProject();
    if (active) {
      res.writeHead(302, {
        Location: `/${encodeURIComponent(active.group)}/${encodeURIComponent(active.project)}/`,
      });
      res.end();
      return;
    }
    res.writeHead(302, { Location: '/_projects' });
    res.end();
    return;
  }

  if (pathname.startsWith('/_set/')) {
    const encoded = pathname.slice('/_set/'.length);
    const id = decodeURIComponent(encoded);
    const entry = findProjectById(id) || findProjectByShortName(id);
    if (entry) {
      setProjectSession(res, entry);
      res.writeHead(302, {
        Location: `/${encodeURIComponent(entry.group)}/${encodeURIComponent(entry.project)}/`,
      });
      res.end();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Project "${id}" not found`);
    return;
  }

  if (pathname.startsWith(`${PROJECT_PREFIX}/`)) {
    const rest = pathname.slice(PROJECT_PREFIX.length + 1);
    const slashIndex = rest.indexOf('/');
    const encodedId = slashIndex >= 0 ? rest.slice(0, slashIndex) : rest;
    const projectId = decodeURIComponent(encodedId);
    const entry = findProjectByAlias(projectId);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Project "${projectId}" not found`);
      return;
    }

    const subPath = slashIndex >= 0 ? rest.slice(slashIndex) || '/' : '/';
    setProjectSession(res, entry);
    serveProjectPath(
      req,
      res,
      entry,
      subPath,
      `${PROJECT_PREFIX}/${encodeURIComponent(entry.id)}`,
    );
    return;
  }

  // /<group>/<project>/... has priority over /<project>/...
  const directRest = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  const directParts = directRest.split('/').filter(Boolean);
  if (directParts.length >= 2) {
    const group = decodeURIComponent(directParts[0]);
    const project = decodeURIComponent(directParts[1]);
    const entry = findProjectByGroupAndProject(group, project);
    if (entry) {
      const subPath =
        directParts.length > 2
          ? `/${directParts.slice(2).map((p) => decodeURIComponent(p)).map(encodeURIComponent).join('/')}`
          : '/';
      setProjectSession(res, entry);
      serveProjectPath(
        req,
        res,
        entry,
        subPath,
        `/${encodeURIComponent(entry.group)}/${encodeURIComponent(entry.project)}`,
      );
      return;
    }
  }

  // /<project>/...
  if (directParts.length >= 1) {
    const alias = decodeURIComponent(directParts[0]);
    if (alias && isValidName(alias)) {
      const entry = findProjectByAlias(alias);
      if (entry) {
        const subPath = directParts.length > 1 ? `/${directRest.slice(alias.length + 1)}` : '/';
        setProjectSession(res, entry);
        serveProjectPath(req, res, entry, subPath, `/${encodeURIComponent(alias)}`);
        return;
      }
    }
  }

  // Asset compatibility for apps using absolute /assets paths.
  const inferred = inferProject(req);
  if (inferred) {
    serveProjectPath(req, res, inferred, pathname);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
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
  console.log('\nPreview roots:');
  for (const root of PREVIEW_ROOTS) {
    console.log(`  - ${root}`);
  }
  console.log(`Projects page: http://localhost:${PORT}/_projects`);
  console.log(
    `Active project: ${active ? `${active.group}/${active.project} (${active.id})` : 'none'}`,
  );
});
