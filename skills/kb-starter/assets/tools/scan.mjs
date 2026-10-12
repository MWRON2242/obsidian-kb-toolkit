#!/usr/bin/env node
/**
 * scan.mjs —— 知识库登记器
 *
 * 只登记原件的位置与指纹，绝不复制/修改/移动原件。
 * 读取 tools/sources.json 的登记源，扫描匹配的文件，合并进 index/catalog.jsonl。
 * 已存在的字段（title/tags/note/status 等）会被保留，只更新指纹与时间戳。
 *
 * 用法：
 *   node tools/scan.mjs                 # 常规扫描（新文件算 hash，已存在且未变则跳过）
 *   node tools/scan.mjs --hash          # 对全部文件重算 sha256（慢，用于核验）
 *   node tools/scan.mjs --root=study    # 只扫某个登记源
 *   node tools/scan.mjs --dry           # 只报告，不写 catalog
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, stat, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const CATALOG = path.join(KB, 'index', 'catalog.jsonl');
const SOURCES = path.join(KB, 'tools', 'sources.json');
const QUEUE = path.join(KB, 'index', 'extract-queue.json');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const hit = argv.find((a) => a.startsWith(`${n}=`));
  return hit ? hit.slice(n.length + 1) : null;
};
const RECHECK_ALL = flag('--hash');
const DRY = flag('--dry');
const ONLY_ROOT = opt('--root');

const today = new Date().toISOString().slice(0, 10);

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(p);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

function cleanTitle(file) {
  return path.basename(file, path.extname(file)).replace(/\s+/g, ' ').trim();
}

function ignored(name, patterns) {
  return patterns.some((p) => name.includes(p));
}

async function walk(root, cfg, defaults) {
  const include = (cfg.include || defaults.include).map((e) => e.toLowerCase());
  const ignoreNames = [...defaults.ignoreNames, ...(cfg.ignoreNames || [])];
  const ignoreDirs = [...(defaults.ignoreDirs || []), ...(cfg.ignoreDirs || [])].map((d) => d.toLowerCase());
  const maxBytes = cfg.maxBytes ?? defaults.maxBytes;
  const files = [];

  async function visit(dir, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.warn(`  ! 无法读取目录 ${dir}: ${err.code}`);
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (ignored(e.name, ignoreNames)) continue;
      if (e.isDirectory()) {
        if (ignoreDirs.includes(e.name.toLowerCase())) continue;
        if (e.isSymbolicLink()) continue; // 防 NTFS 联接点造成目录循环
        if (cfg.recursive !== false && depth < 12) await visit(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (!include.includes(path.extname(e.name).toLowerCase())) continue;
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      files.push({ full, size: st.size, mtime: st.mtime, oversize: st.size > maxBytes });
    }
  }

  await visit(root, 0);
  return files;
}

async function loadCatalog() {
  const map = new Map();
  try {
    const txt = await readFile(CATALOG, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      try {
        const rec = JSON.parse(s);
        map.set(rec.source.toLowerCase(), rec);
      } catch {
        console.warn('  ! catalog 中有无法解析的行，已跳过');
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return map;
}

function nextId(existing) {
  let max = 0;
  for (const rec of existing.values()) {
    const m = /^kb-(\d+)$/.exec(rec.id || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return () => `kb-${String(++max).padStart(4, '0')}`;
}

function rel(p) {
  const r = path.relative(KB, p);
  return r.split(path.sep).join('/');
}

const cfgFile = JSON.parse(await readFile(SOURCES, 'utf8'));
const defaults = cfgFile.defaults;
const catalog = await loadCatalog();
const newId = nextId(catalog);

const stats = { scanned: 0, added: 0, changed: 0, unchanged: 0, missing: 0, oversize: 0, hashed: 0 };
const queue = [];
const seen = new Set();

for (const cfg of cfgFile.roots) {
  if (cfg.enabled === false) continue;
  if (ONLY_ROOT && cfg.id !== ONLY_ROOT) continue;
  if (!cfg.path) continue;

  let exists = true;
  try {
    await stat(cfg.path);
  } catch {
    exists = false;
  }
  console.log(`\n[${cfg.id}] ${cfg.path}${exists ? '' : '  (路径不存在，跳过)'}`);
  if (!exists) continue;

  const files = await walk(cfg.path, cfg, defaults);
  console.log(`  匹配 ${files.length} 个文件`);

  for (const f of files) {
    const key = f.full.toLowerCase();
    seen.add(key);
    stats.scanned++;
    const prev = catalog.get(key);
    const mtime = f.mtime.toISOString();

    if (f.oversize) stats.oversize++;

    if (prev && prev.bytes === f.size && prev.mtime === mtime && prev.status !== 'missing' && !RECHECK_ALL) {
      prev.last_seen = today;
      stats.unchanged++;
      if (cfg.extractText && !prev.text && !f.oversize) queue.push({ id: prev.id, source: prev.source });
      continue;
    }

    let sha256 = prev?.sha256 ?? null;
    const needHash = RECHECK_ALL || !prev || prev.bytes !== f.size || prev.mtime !== mtime;
    if (needHash) {
      try {
        sha256 = await hashFile(f.full);
        stats.hashed++;
      } catch (err) {
        console.warn(`  ! 无法读取 ${f.full}: ${err.code}`);
        continue;
      }
    }

    if (!prev) {
      const rec = {
        id: newId(),
        title: cleanTitle(f.full),
        source: f.full,
        source_type: path.extname(f.full).slice(1).toLowerCase(),
        root: cfg.id,
        label: cfg.label || cfg.id,
        bytes: f.size,
        mtime,
        sha256,
        tags: [],
        status: f.oversize && cfg.extractText !== false ? 'deferred' : 'registered',
        note: null,
        text: null,
        extractText: cfg.extractText !== false,
        first_seen: today,
        last_seen: today,
        updated: today,
      };
      catalog.set(key, rec);
      stats.added++;
      if (rec.extractText && !f.oversize) queue.push({ id: rec.id, source: rec.source });
    } else {
      prev.bytes = f.size;
      prev.mtime = mtime;
      prev.sha256 = sha256;
      prev.root = cfg.id;
      prev.label = cfg.label || cfg.id;
      prev.extractText = cfg.extractText !== false;
      prev.last_seen = today;
      if (prev.status === 'missing') prev.status = prev.note ? 'noted' : 'registered';
      if (prev.text) queue.push({ id: prev.id, source: prev.source, reason: 'content-changed' });
      stats.changed++;
    }
  }
}

for (const rec of catalog.values()) {
  if (!seen.has(rec.source.toLowerCase()) && rec.status !== 'missing') {
    const cfg = cfgFile.roots.find((r) => r.id === rec.root);
    if (ONLY_ROOT && cfg?.id !== ONLY_ROOT) continue;
    if (!cfg || cfg.enabled === false) continue;
    rec.status = 'missing';
    rec.updated = today;
    stats.missing++;
    console.log(`  - 原件不在了，标记 missing: ${rec.source}`);
  }
}

const records = [...catalog.values()].sort((a, b) => a.id.localeCompare(b.id));

if (!DRY) {
  await mkdir(path.dirname(CATALOG), { recursive: true });
  await writeFile(CATALOG, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  await writeFile(QUEUE, JSON.stringify({ generated: today, items: queue }, null, 2), 'utf8');
}

console.log('\n===== 扫描结果 =====');
console.log(`匹配文件   : ${stats.scanned}`);
console.log(`新增登记   : ${stats.added}`);
console.log(`指纹变更   : ${stats.changed}`);
console.log(`未变化     : ${stats.unchanged}`);
console.log(`原件丢失   : ${stats.missing}`);
console.log(`超大跳过   : ${stats.oversize}  (标记 deferred)`);
console.log(`目录总数   : ${records.length}`);
console.log(`待抽取文本 : ${queue.length}${DRY ? '  (--dry 未写入)' : `  → ${rel(QUEUE)}`}`);
console.log(`目录文件   : ${rel(CATALOG)}`);
