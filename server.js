// Classplus encrypted-HLS auto downloader — local receiver + full pipeline
// Start once:  node server.js
// Then click the bookmarklet on the video page. MP4 lands in Downloads.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8777);
const HOST = process.env.HOST || '127.0.0.1';   // VPS: HOST=0.0.0.0
// Auth token — always ON. env CPDL_TOKEN (VPS) or auto-generated token.txt
// (local + tunnel mode). /ping from direct localhost reveals it so the
// extension can auto-fill its settings; tunnel callers never see it.
let TOKEN = process.env.CPDL_TOKEN || '';
const TOKEN_FILE = path.join(__dirname, 'token.txt');
if (!TOKEN) {
  try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
  if (!TOKEN) {
    TOKEN = crypto.randomBytes(16).toString('hex');
    try { fs.writeFileSync(TOKEN_FILE, TOKEN + '\n'); } catch {}
  }
}
const HEADERS = {
  'Referer': 'https://web.classplusapp.com/',
  'Origin': 'https://web.classplusapp.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
};
const FFMPEG = process.env.FFMPEG || (process.platform === 'win32'
  ? 'C:\\Users\\cyber_raj1\\Desktop\\ffmpeg-9.0.1-essentials_build\\bin\\ffmpeg.exe'
  : 'ffmpeg');
// where finished MP4s land: Windows -> Downloads (direct), VPS -> ./files (served back to the popup)
const OUT_DIR = process.env.OUT_DIR || (process.platform === 'win32'
  ? 'C:\\Users\\cyber_raj1\\Downloads'
  : path.join(__dirname, 'files'));
const TMP = path.join(__dirname, '_work');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

// PARALLEL jobs — each download gets its own status object so concurrent
// pipelines never race a shared counter (no lock, no queue: everything
// starts immediately and runs at the same time).
const jobs = new Map(); // id -> {id, title, quality, state, msg, pct, file, started}
let jobSeq = 0;

function newJob(title, quality) {
  const id = 'j' + (++jobSeq);
  const job = { id, title: title || '', quality: quality || '', state: 'running', msg: 'starting…', pct: 2, file: null, started: Date.now() };
  jobs.set(id, job);
  return job;
}
const updJob = (job, p) => { Object.assign(job, p); };
const jobList = () => [...jobs.values()].sort((a, b) => b.started - a.started);

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

const REQ_TIMEOUT = 20000; // 20s — a stalled segment aborts instead of hanging the job forever
async function fetchText(url) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(REQ_TIMEOUT) });
  if (!r.ok) throw new Error(`GET ${r.status} ${url.slice(0, 120)}`);
  return await r.text();
}
async function fetchBuf(url) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(REQ_TIMEOUT) });
  if (!r.ok) throw new Error(`GET ${r.status} ${url.slice(0, 120)}`);
  return Buffer.from(await r.arrayBuffer());
}
// retry wrapper: a transient stall/403 retries instead of killing the whole job
async function withRetry(fn, tries = 3, label = 'req') {
  let last;
  for (let a = 0; a < tries; a++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (a < tries - 1) { log(`  ${label} retry ${a + 1}: ${e.message}`); await new Promise(r => setTimeout(r, 700 * (a + 1))); }
    }
  }
  throw last;
}

function parseSegs(playlist) {
  return playlist.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && /\.ts($|\?)/i.test(l));
}

// From a master playlist, pick a variant (prefer 720p / highest bandwidth)
function pickVariant(master, masterUrl) {
  const lines = master.split(/\r?\n/).map(l => l.trim());
  const cands = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bw = (lines[i].match(/BANDWIDTH=(\d+)/) || [])[1];
      const res = (lines[i].match(/RESOLUTION=(\d+x\d+)/) || [])[1];
      const next = lines[i + 1];
      if (next && !next.startsWith('#')) cands.push({ url: new URL(next, masterUrl).href, bw: +bw || 0, res });
    }
  }
  if (!cands.length) return null;
  const p720 = cands.find(c => c.res === '1280x720') || cands.find(c => (c.res || '').endsWith('720'));
  if (p720) return p720.url;
  cands.sort((a, b) => b.bw - a.bw);
  return cands[0].url;
}

// Walk m3u8 url(s) -> { base, segs }  (handles master or variant input)
async function resolveSegments(urls) {
  const attempts = Array.isArray(urls) ? urls : [urls];
  for (const u of attempts) {
    if (!/\.m3u8/i.test(u)) continue;
    let txt;
    try { txt = await fetchText(u); } catch (e) { log('  m3u8 fail:', e.message); continue; }
    if (/#EXT-X-STREAM-INF/.test(txt)) {
      const vUrl = pickVariant(txt, u);
      if (!vUrl) continue;
      log('  variant:', vUrl.slice(0, 140));
      const vt = await fetchText(vUrl);
      const segs = parseSegs(vt);
      if (segs.length) return { base: vUrl, segs };
    } else if (/#EXTINF/.test(txt)) {
      const segs = parseSegs(txt);
      if (segs.length) return { base: u, segs };
    }
  }
  throw new Error('no variant playlist with segments resolved');
}

function sanitizeName(s) {
  return (s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function runPipeline({ m3u8, key, iv, title, quality }, job) {
  const set = (p) => updJob(job, p);
  const keyBuf = Buffer.from(key, 'hex');
  const ivBuf = Buffer.from(iv, 'hex');
  if (keyBuf.length !== 16) throw new Error('key must be 16 bytes');
  if (ivBuf.length !== 16) throw new Error('iv must be 16 bytes');

  log('resolve playlists...', quality ? `[${quality}]` : '');
  set({ state: 'running', msg: 'resolving playlists…', pct: 5 });
  const { base, segs } = await resolveSegments(m3u8);
  log(`segments: ${segs.length}  base=${base.slice(0, 120)}`);
  set({ state: 'running', msg: `downloading ${segs.length} segments…`, pct: 10 });

  const runId = Date.now().toString(36) + '-' + job.id;
  const dir = path.join(TMP, runId);
  const encDir = path.join(dir, 'enc');
  const decDir = path.join(dir, 'dec');
  fs.mkdirSync(encDir, { recursive: true });
  fs.mkdirSync(decDir, { recursive: true });

  // download sequentially (valid files -> no throttle), decrypt in-stream to save disk
  let ok = 0, bad = 0;
  const listLines = [];
  for (let i = 0; i < segs.length; i++) {
    const segUrl = new URL(segs[i], base).href;
    let buf;
    try {
      buf = await withRetry(() => fetchBuf(segUrl), 3, `seg${i}`);
    } catch (e) {
      bad++; log(`  seg${i} FAILED after retries: ${e.message}`);
      set({ state: 'running', msg: `segment ${i + 1}/${segs.length}  retry failed`, pct: 10 + Math.round((i + 1) / segs.length * 60) });
      continue;
    }
    if (buf.length % 16 !== 0) { bad++; log(`  seg${i}: len ${buf.length} not /16`); continue; }
    const dec = crypto.createDecipheriv('aes-128-cbc', keyBuf, ivBuf);
    dec.setAutoPadding(false);
    const out = Buffer.concat([dec.update(buf), dec.final()]);
    // TS sync check
    let hit = 0, tot = 0;
    for (let o = 0; o + 188 <= out.length && tot < 6; o += 188) { tot++; if (out[o] === 0x47) hit++; }
    const good = hit >= Math.ceil(tot * 0.8);
    if (good) ok++; else bad++;
    const name = String(i).padStart(3, '0') + '.ts';
    fs.writeFileSync(path.join(decDir, name), out);
    listLines.push(`file '${path.join(decDir, name).replace(/\\/g, '/')}'`);
    if (i % 25 === 0 || !good) log(`  seg ${i + 1}/${segs.length}  ${good ? 'TS-ok' : 'TS-FAIL'}`);
    set({ state: 'running', msg: `segment ${i + 1}/${segs.length}  decrypt`, pct: 10 + Math.round((i + 1) / segs.length * 60) });
  }
  log(`decrypted: ${ok} ok / ${bad} bad`);
  if (ok < segs.length * 0.9) throw new Error(`too many bad segments (${bad}/${segs.length}) — key/iv mismatch?`);

  const listPath = path.join(dir, 'list.txt');
  fs.writeFileSync(listPath, listLines.join('\n') + '\n');

  // filename: title (from page) or content hash from url, + quality
  let name = sanitizeName(title);
  if (!name) {
    const m = /\/([0-9a-f]{32})-[A-Za-z0-9_]+-encn\//.exec(base) || /\/([0-9a-f]{32})/.exec(base);
    name = m ? `classplus_${m[1].slice(0, 12)}` : 'classplus_video';
  }
  if (quality) name = `${name} [${sanitizeName(quality)}]`;
  const outPath = path.join(OUT_DIR, name + '.mp4');
  let finalPath = outPath, n = 1;
  while (fs.existsSync(finalPath)) { finalPath = path.join(OUT_DIR, `${name} (${n++}).mp4`); }

  log('ffmpeg mux ->', path.basename(finalPath));
  set({ state: 'running', msg: 'muxing MP4…', pct: 85 });
  await new Promise((res, rej) => {
    execFile(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy', '-bsf:a', 'aac_adtstoasc', finalPath],
      { windowsHide: true }, (e, so, se) => {
        if (e) rej(new Error('ffmpeg: ' + (se || e.message).slice(-400)));
        else res();
      });
  });

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  const size = fs.statSync(finalPath).size;
  log('DONE ->', finalPath, `(${(size / 1048576).toFixed(1)} MB)`);
  set({ state: 'done', msg: `done (${(size / 1048576).toFixed(1)} MB)`, file: finalPath,
        fileUrl: '/file?name=' + encodeURIComponent(path.basename(finalPath)) + (TOKEN ? '&token=' + encodeURIComponent(TOKEN) : ''),
        pct: 100 });
  return { file: finalPath, size, segments: segs.length, ok };
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  let u;
  try { u = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); return res.end(); }

  // token gate — active only when CPDL_TOKEN is set (VPS mode)
  const needAuth = () => {
    if (!TOKEN) return false;
    if ((u.searchParams.get('token') || '') === TOKEN) return false;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":"bad token"}');
    return true;
  };

  if (u.pathname === '/ping') {
    // token ONLY for direct localhost callers. Via the cloudflared tunnel the
    // socket is loopback too, but Host is xyz.trycloudflare.com -> no token.
    const addr = req.socket.remoteAddress || '';
    const host = req.headers.host || '';
    const loopback = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/i.test(addr);
    const localHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, name: 'classplus-dl', auth: true,
      ...(loopback && localHost ? { token: TOKEN } : {}) }));
  }
  if (req.method === 'POST' && u.pathname === '/download') {
    if (needAuth()) return;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch { res.writeHead(400); return res.end('{"error":"bad json"}'); }
      const { m3u8, key, iv, title, quality } = payload || {};
      if (!m3u8 || !key || !iv) { res.writeHead(400); return res.end('{"error":"need m3u8,key,iv"}'); }

      log('received job:', { title, quality, key: key.slice(0, 8) + '...', m3u8: (Array.isArray(m3u8) ? m3u8[0] : m3u8).slice(0, 90) });
      // respond immediately, run in background — PARALLEL: har click apna job
      // start karta hai, koi kisi ka wait nahi karta.
      const job = newJob(title, quality);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: true, id: job.id }));
      runPipeline({ m3u8, key, iv, title, quality }, job)
        .then(r => log(`JOB OK [${job.id}]`, JSON.stringify(r)))
        .catch(e => {
          log(`JOB FAIL [${job.id}]:`, e.message);
          updJob(job, { state: 'error', msg: e.message, pct: 5 });
        });
    });
    return;
  }
  if (req.method === 'GET' && u.pathname === '/status') {
    if (needAuth()) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // all jobs (running first, then done/error) + legacy single-job shape
    const list = jobList();
    const active = list.find(j => j.state === 'running') || list[0] || { state: 'idle', msg: 'no job yet', pct: 0 };
    return res.end(JSON.stringify({ ...active, jobs: list }));
  }
  if (req.method === 'GET' && u.pathname === '/files') {
    if (needAuth()) return;
    const list = fs.readdirSync(OUT_DIR)
      .filter(f => f.toLowerCase().endsWith('.mp4'))
      .map(f => {
        const s = fs.statSync(path.join(OUT_DIR, f));
        return { name: f, size: s.size, url: '/file?name=' + encodeURIComponent(f) + (TOKEN ? '&token=' + encodeURIComponent(TOKEN) : '') };
      })
      .sort((a, b) => b.size - a.size);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ files: list }));
  }
  if (req.method === 'GET' && u.pathname === '/file') {
    if (needAuth()) return;
    const name = path.basename(u.searchParams.get('name') || '');
    const fp = path.join(OUT_DIR, name);
    if (!name.toLowerCase().endsWith('.mp4') || !fs.existsSync(fp)) { res.writeHead(404); return res.end('{"error":"no file"}'); }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Disposition': 'attachment; filename="' + name.replace(/"/g, '') + '"',
      'Content-Length': fs.statSync(fp).size,
    });
    fs.createReadStream(fp).pipe(res);
    return;
  }
  if (req.method === 'GET' && u.pathname === '/tunnel') {
    if (needAuth()) return;
    // current cloudflared quick-tunnel URL (written to tunnel.log on start)
    let url = null;
    try {
      const t = fs.readFileSync(path.join(TMP, 'tunnel.log'), 'utf8').slice(-40000);
      const m = t.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m) url = m[0];
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ url }));
  }
  res.writeHead(404); res.end('{"error":"not found"}');
});

server.listen(PORT, HOST, () => {
  log(`classplus-dl server up → http://${HOST}:${PORT}`);
  log('auth: token required — localhost /ping auto-shares it with the extension');
});
