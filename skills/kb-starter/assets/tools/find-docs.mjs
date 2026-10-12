#!/usr/bin/env node
/**
 * find-docs.mjs —— 全盘搜索「散落的 Word 文档」（只读，不移动不修改任何文件）
 *
 * 用途：在把文件收进知识库之前，先看清它们到底散落在哪里。
 *   1. 按扩展名找 .doc/.docx/.docm/.dotx/.dotm/.rtf；
 *   2. 跳过系统与噪音目录（Windows / Program Files / AppData / node_modules ...）；
 *   3. 跳过符号链接与 NTFS 联接点，避免目录循环；
 *   4. 对照知识库 catalog，标出哪些已经登记过；
 *   5. 输出按「顶层目录」分组的统计 + 完整清单 JSON。
 *
 * 用法：
 *   node tools/find-docs.mjs                      # 扫 C:\ 和 D:\
 *   node tools/find-docs.mjs --root=D:\           # 只扫 D 盘
 *   node tools/find-docs.mjs --ext=.docx,.doc     # 自定义扩展名
 *   node tools/find-docs.mjs --include-system     # 连 Program Files / AppData 一起扫
 *   node tools/find-docs.mjs --quiet              # 只输出汇总
 */
import { readdirSync, lstatSync, statSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (n) => {
  const hit = argv.find((a) => a.startsWith(`${n}=`));
  return hit ? hit.slice(n.length + 1) : null;
};
const flag = (n) => argv.includes(n);

const KB = path.resolve(import.meta.dirname, '..');
const OUT = path.join(KB, 'index', 'found-docs.json');
const CATALOG = path.join(KB, 'index', 'catalog.jsonl');

const ROOTS = (opt('--root') || 'C:\\,D:\\').split(',').map((s) => s.trim()).filter(Boolean);
const EXTS = new Set(
  (opt('--ext') || '.doc,.docx,.docm,.dot,.dotx,.dotm,.rtf')
    .split(',')
    .map((e) => (e.startsWith('.') ? e : '.' + e).toLowerCase()),
);
const INCLUDE_SYSTEM = flag('--include-system');
const QUIET = flag('--quiet');
const MAX_DEPTH = 40;

// 噪音目录：默认跳过（这些位置几乎不会有「用户的散落文档」）
const SKIP_ALWAYS = new Set(
  [
    '$recycle.bin',
    'system volume information',
    'windows',
    'winsxs',
    'windowsapps',
    'node_modules',
    '.git',
    '.gradle',
    '.pnpm-store',
    '.npm-cache',
    '.cache',
    '.deps-cache',
    '.tmp-render',
    '$windows.~bt',
    '$windows.~ws',
    'recovery',
    'msocache',
  ].map((s) => s.toLowerCase()),
);
const SKIP_SYSTEM = new Set(
  [
    'program files',
    'program files (x86)',
    'programdata',
    'appdata',
    'application data',
    'documents and settings',
    'all users',
    'default user',
    'local settings',
    'temporary internet files',
    'start menu',
    '开始菜单',
    'msys64',
    'keil_v5',
    'microsoft visual studio',
    'intellij idea',
    'obs studio',
    'steam',
    'arduino15',
    'renesas',
    'kicad',
    'krita',
    'live2d cubism 5.3',
    'pcl_dsh',
  ].map((s) => s.toLowerCase()),
);

/** 已登记的原件路径（小写），用于标记「已入库」 */
const registered = new Set();
if (existsSync(CATALOG)) {
  for (const line of readFileSync(CATALOG, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      registered.add(JSON.parse(line).source.toLowerCase());
    } catch {
      /* 坏行忽略 */
    }
  }
}

const hits = [];
const errors = [];
let dirs = 0;
let files = 0;
const skipHits = new Map();

function walk(dir, depth) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    errors.push(`${dir} (${err.code})`);
    return;
  }
  dirs++;
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const lower = e.name.toLowerCase();
    if (e.isSymbolicLink()) continue; // 含 NTFS 联接点，防循环

    if (e.isDirectory()) {
      if (SKIP_ALWAYS.has(lower)) {
        skipHits.set(e.name, (skipHits.get(e.name) || 0) + 1);
        continue;
      }
      if (!INCLUDE_SYSTEM && SKIP_SYSTEM.has(lower)) {
        skipHits.set(e.name, (skipHits.get(e.name) || 0) + 1);
        continue;
      }
      // 双保险：个别联接点 Dirent 不标记，用 lstat 再确认一次
      try {
        if (lstatSync(full).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      walk(full, depth + 1);
      continue;
    }

    if (!e.isFile()) continue;
    files++;
    const ext = path.extname(e.name).toLowerCase();
    if (!EXTS.has(ext)) continue;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    hits.push({
      path: full,
      name: e.name,
      ext,
      bytes: st.size,
      mtime: st.mtime.toISOString().slice(0, 10),
      registered: registered.has(full.toLowerCase()),
    });
  }
}

console.log(`开始扫描：${ROOTS.join('、')}　扩展名 ${[...EXTS].join(' ')}${INCLUDE_SYSTEM ? '　（含系统目录）' : ''}`);
const t0 = Date.now();
for (const root of ROOTS) {
  if (!existsSync(root)) {
    console.log(`  跳过不存在的根：${root}`);
    continue;
  }
  if (!QUIET) console.log(`  扫描 ${root} ...`);
  walk(root, 0);
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);

/* ---------- 统计 ---------- */
const byGroup = new Map();
for (const h of hits) {
  const parts = h.path.split(path.sep).filter(Boolean);
  const group = parts.slice(0, 2).join(path.sep) + path.sep; // 例如 <根目录>\
  if (!byGroup.has(group)) byGroup.set(group, { count: 0, bytes: 0, items: [] });
  const g = byGroup.get(group);
  g.count++;
  g.bytes += h.bytes;
  g.items.push(h);
}

const byExt = new Map();
for (const h of hits) byExt.set(h.ext, (byExt.get(h.ext) || 0) + 1);

const byName = new Map();
for (const h of hits) {
  const k = h.name.toLowerCase();
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k).push(h.path);
}

const totalBytes = hits.reduce((a, h) => a + h.bytes, 0);
const unregistered = hits.filter((h) => !h.registered);

console.log(`\n===== 扫描完成（${secs}s）=====`);
console.log(`遍历目录 ${dirs.toLocaleString()} 个 / 文件 ${files.toLocaleString()} 个`);
if (errors.length) console.log(`无权限目录 ${errors.length} 个（已跳过）`);
console.log(`\n找到 Word 文档 ${hits.length} 个，合计 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`其中已在知识库登记：${hits.length - unregistered.length} 个；**尚未登记：${unregistered.length} 个**`);
console.log(`扩展名分布：${[...byExt].sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e} ${n}`).join('　')}`);

console.log(`\n----- 按位置分组（前 30）-----`);
const groups = [...byGroup].sort((a, b) => b[1].count - a[1].count);
for (const [g, v] of groups.slice(0, 30)) {
  const reg = v.items.filter((i) => i.registered).length;
  console.log(`${String(v.count).padStart(4)} 个  ${(v.bytes / 1024 / 1024).toFixed(1).padStart(7)} MB  已入库 ${String(reg).padStart(3)}  ${g}`);
}
if (groups.length > 30) console.log(`... 另有 ${groups.length - 30} 个目录未列出`);

const dupes = [...byName].filter(([, v]) => v.length > 1).sort((a, b) => b[1].length - a[1].length);
console.log(`\n----- 同名重复（前 10，共 ${dupes.length} 组）-----`);
for (const [name, paths] of dupes.slice(0, 10)) {
  console.log(`${name}  ×${paths.length}`);
  for (const p of paths.slice(0, 4)) console.log(`      ${p}`);
}

console.log(`\n----- 最大的 10 个 -----`);
for (const h of [...hits].sort((a, b) => b.bytes - a.bytes).slice(0, 10)) {
  console.log(`${(h.bytes / 1024 / 1024).toFixed(2).padStart(7)} MB  ${h.mtime}  ${h.path}`);
}

console.log(`\n----- 最近修改的 10 个 -----`);
for (const h of [...hits].sort((a, b) => b.mtime.localeCompare(a.mtime)).slice(0, 10)) {
  console.log(`${h.mtime}  ${(h.bytes / 1024).toFixed(0).padStart(6)} KB  ${h.path}`);
}

try {
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        scannedAt: new Date().toISOString(),
        roots: ROOTS,
        exts: [...EXTS],
        stats: { dirs, files, hits: hits.length, unregistered: unregistered.length, bytes: totalBytes, seconds: Number(secs) },
        groups: groups.map(([g, v]) => ({ group: g, count: v.count, bytes: v.bytes })),
        items: hits.sort((a, b) => a.path.localeCompare(b.path)),
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`\n完整清单已写入：${path.relative(KB, OUT)}（${hits.length} 条，含路径/大小/修改日期/是否已登记）`);
} catch (err) {
  console.log(`\n清单写入失败：${err.message}`);
}
