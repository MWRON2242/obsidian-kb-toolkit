#!/usr/bin/env node
/**
 * fix-id-links.mjs —— 把指向 kb-XXXX 的 wikilink 统一归一化成「完整文件名 + 别名」
 *
 * 背景：卡片之间互链时容易出现三种写法，后两种都会失效：
 *   ① [[kb-0505-2026-08-19-第七题提示|kb-0505]]   ← 文件名正确，可解析
 *   ② [[kb-0505-2026-08-19-第七题提示]]           ← 用的 catalog 标题，但实际文件名不含日期 → 断链
 *   ③ [[kb-0505]]                                 ← 只写 id：Obsidian 会在库根新建空笔记抢走解析
 * 本脚本按 catalog 里「id → 实际卡片文件名」的映射，把 ②③ 统一改写成 ① 的形式。
 *
 * 代码块与行内代码里的示例不会被改（文档要保留反面例子）。
 * 找不到对应卡片的 id 会被列进"无法修复"清单，不会瞎猜。
 *
 * 用法：
 *   node tools/fix-id-links.mjs --check
 *   node tools/fix-id-links.mjs
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const CHECK = process.argv.includes('--check');

const records = readFileSync(path.join(KB, 'index', 'catalog.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const idToFile = new Map();
for (const r of records) if (r.note) idToFile.set(r.id, path.basename(r.note, '.md'));

const SKIP_DIRS = new Set(['.obsidian', 'tools', 'node_modules', '.deps-cache', 'chats', 'external', 'fulltext', 'cache']);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

const outsideCode = (text, fn) =>
  text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : fn(seg)))
    .join('');

// 匹配 [[kb-XXXX...]] / [[kb-XXXX...|别名]] / [[kb-XXXX]]
// ⚠️ 必须排除 materials/ 里的素材条目文件名（形如 kb-0442-01-屈原…）——
// 那种「id + 两位序号」不是卡片 id 引用，改写会把素材总表的链接指错地方。
const LINK = /\[\[(kb-\d{4})(?:[^\]|]*)?(?:\|([^\]]*))?\]\]/g;
const MATERIAL_FILE = /^kb-\d{4}-\d{2}-/;

let changedFiles = 0;
let rewritten = 0;
const unresolved = [];
const report = [];

for (const f of walk(KB)) {
  const rel = path.relative(KB, f).split(path.sep).join('/');
  const text = readFileSync(f, 'utf8');
  let count = 0;
  const next = outsideCode(text, (seg) =>
    seg.replace(LINK, (m, id, alias) => {
      const target = m.slice(2, m.indexOf('|') === -1 ? -2 : m.indexOf('|'));
      if (MATERIAL_FILE.test(target)) return m; // materials/ 的素材条目，不是卡片引用
      const file = idToFile.get(id);
      if (!file) {
        unresolved.push(`${rel} → ${m}（${id} 还没有摘要卡）`);
        return m;
      }
      const disp = (alias || '').trim() || id;
      const want = `[[${file}|${disp}]]`;
      if (want === m) return m;
      count++;
      rewritten++;
      return want;
    }),
  );
  if (count) {
    changedFiles++;
    report.push(`  ${rel}  ×${count}`);
    if (!CHECK) writeFileSync(f, next, 'utf8');
  }
}

console.log(`扫描 ${walk(KB).length} 个 md${CHECK ? '（--check 只报告）' : ''}`);
if (report.length) console.log(`\n归一化的文件 ${report.length} 个，共 ${rewritten} 处链接：\n${report.join('\n')}`);
else console.log('\n所有 kb 链接都已是「完整文件名|别名」形式 ✓');

if (unresolved.length) {
  console.log(`\n⚠ ${unresolved.length} 处无法自动修复（目标卡片不存在）：`);
  for (const u of [...new Set(unresolved)]) console.log(`  · ${u}`);
}
if (!CHECK && changedFiles) console.log(`\n已改写 ${changedFiles} 个文件。`);
