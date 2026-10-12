#!/usr/bin/env node
/**
 * bootstrap.mjs —— 在一台新机器上从零搭起知识库骨架（kb-starter 的第 0 步）
 *
 * 它会：建目录骨架 → 拷 34 个工具脚本 → 写 AGENTS.md / tags.md / README.md / .gitignore / sources.json
 *      （把模板里的 __KB__ / __NAME__ / __DATE__ 换成实际值）→ 打印后续步骤。
 *
 * 安全约定：**只补缺失，不删不改**已有文件；已存在的文件默认跳过，加 --force 才覆盖。
 *
 * 用法：
 *   node bootstrap.mjs --kb="D:\my-kb" --name="我的知识库" --roots="D:\学习,D:\作文素材" [--dry] [--force]
 */
import { mkdirSync, copyFileSync, readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SKILL_ROOT = path.resolve(import.meta.dirname, '..');
const ASSETS = path.join(SKILL_ROOT, 'assets');
const argv = process.argv.slice(2);
const opt = (n, d = '') => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const KB = opt('kb');
const NAME = opt('name', '我的知识库');
const ROOTS = opt('roots')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DRY = argv.includes('--dry');
const FORCE = argv.includes('--force');

if (!KB) {
  console.error('用法: node bootstrap.mjs --kb="<知识库路径>" [--name=...] [--roots="目录1,目录2"] [--dry] [--force]');
  process.exit(1);
}
if (existsSync(KB) && readdirSync(KB).length && !FORCE && !DRY) {
  console.error(`目标目录已存在且非空：${KB}\n如确认要往里补骨架，加 --force（不会删除任何文件）。`);
  process.exit(1);
}

const DIRS = ['notes', 'digests', 'index', 'cache/text', 'inbox', 'materials', 'vocab', 'review', 'external', 'fulltext', 'chats', 'tools'];
const acts = [];
const act = (desc, fn) => {
  acts.push(desc);
  if (!DRY) fn();
};
const localize = (s) =>
  s.replaceAll('__KB__', KB).replaceAll('__NAME__', NAME).replaceAll('__DATE__', new Date().toISOString().slice(0, 10));

/** 深度替换对象里的字符串值（**必须在 JSON.parse 之后做**：
 *  否则 Windows 路径里的反斜杠会破坏 JSON 字面量，例如 "D:\学习" 里的 \学 是非法转义） */
const subDeep = (v) =>
  Array.isArray(v)
    ? v.map(subDeep)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subDeep(x)]))
      : typeof v === 'string'
        ? localize(v)
        : v;

for (const d of DIRS) act(`建目录 ${d}/`, () => mkdirSync(path.join(KB, d), { recursive: true }));

// 工具脚本
const toolSrc = path.join(ASSETS, 'tools');
for (const f of readdirSync(toolSrc).sort()) {
  const dst = path.join(KB, 'tools', f);
  if (existsSync(dst) && !FORCE) {
    acts.push(`跳过 tools/${f}（已存在）`);
    continue;
  }
  act(`拷 tools/${f}`, () => copyFileSync(path.join(toolSrc, f), dst));
}
// 自带验收脚本（让新库自我完整）
for (const f of ['verify-fresh.mjs']) {
  const src = path.join(SKILL_ROOT, 'scripts', f);
  if (existsSync(src)) act(`拷 tools/${f}`, () => copyFileSync(src, path.join(KB, 'tools', f)));
}

// 模板
const tpl = (f) => path.join(ASSETS, 'templates', f);
const writeTpl = (srcName, dstRel) => {
  const src = tpl(srcName);
  if (!existsSync(src)) return;
  const dst = path.join(KB, dstRel);
  if (existsSync(dst) && !FORCE) {
    acts.push(`跳过 ${dstRel}（已存在）`);
    return;
  }
  act(`写 ${dstRel}`, () => {
    mkdirSync(path.dirname(dst), { recursive: true });
    const raw = readFileSync(src, 'utf8');
    // JSON 模板走"解析 → 深度替换 → 序列化"，避免反斜杠破坏 JSON
    const out = srcName.endsWith('.json') ? JSON.stringify(subDeep(JSON.parse(raw)), null, 2) : localize(raw);
    writeFileSync(dst, out, 'utf8');
  });
};
writeTpl('AGENTS.md', 'AGENTS.md');
writeTpl('tags.md', 'index/tags.md');
writeTpl('README.md', 'README.md');
writeTpl('gitignore', '.gitignore');
writeTpl('topic-profiles.json', 'tools/topic-profiles.json');
writeTpl('external-sources.json', 'tools/external-sources.json');

// sources.json：模板 + 用户给的原文目录（同样先解析再替换，避免反斜杠问题）
const sourcesTpl = subDeep(JSON.parse(readFileSync(tpl('sources.json'), 'utf8')));
const slug = (p, i) => {
  const base = path.basename(p).replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  return (base || 'root') + (i ? `-${i + 1}` : '');
};
ROOTS.forEach((r, i) =>
  sourcesTpl.roots.push({
    id: slug(r, i),
    path: r,
    label: path.basename(r) || r,
    recursive: true,
    extractText: true,
    note: '用户登记的原始资料目录（只读，不复制、不修改）。',
  }),
);
const sourcesDst = path.join(KB, 'tools', 'sources.json');
if (existsSync(sourcesDst) && !FORCE) acts.push('跳过 tools/sources.json（已存在）');
else act('写 tools/sources.json', () => writeFileSync(sourcesDst, JSON.stringify(sourcesTpl, null, 2), 'utf8'));

console.log(`${DRY ? '[dry-run] ' : ''}知识库：${KB}\n名字：${NAME}　原文目录：${ROOTS.length ? ROOTS.join('、') : '（未指定，之后改 tools/sources.json）'}\n`);
for (const a of acts) console.log('  ' + a);
console.log(`
下一步（按顺序）：
  1) node "${path.join(KB, 'tools', 'verify-fresh.mjs')}" --kb="${KB}"
  2) node tools/scan.mjs                        # 登记源文件
  3) node tools/extract-text.mjs --all          # 抽正文到 cache/text/
  4) 读 cache/text/<id>.txt 写 notes/<id>-<slug>.md   # 建卡（可交给 agent 批量做）
  5) node tools/link-notes.mjs && node tools/build-index.mjs && node tools/obsidian-sync.mjs
  6) node tools/status.mjs                      # 一屏看板
  7) 可选·背单词：node tools/install-obsidian-plugin.mjs st3v3nmw/obsidian-spaced-repetition
本目录已放好 AGENTS.md（agent 会自动加载），把该目录作为 Obsidian 库打开即可。`);
