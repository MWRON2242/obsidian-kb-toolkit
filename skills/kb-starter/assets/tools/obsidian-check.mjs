#!/usr/bin/env node
/**
 * obsidian-check.mjs —— 检查知识库作为 Obsidian vault 的健康状况
 *
 * 检查三件事（Obsidian 最容易踩的坑）：
 *   1. **同名文件**：vault 内出现两个同名 .md，wikilink 就无法唯一解析；
 *   2. **断链**：[[X]] 的目标既不是文件名、也不是任何卡片的 alias；
 *   3. **空 alias / 重复 alias**：两个文件声明同一个 alias 同样会歧义。
 *
 * 只读，不改任何文件。用法：node tools/obsidian-check.mjs
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const SKIP = new Set(['.obsidian', 'node_modules', '.deps-cache', 'tools']);

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

const files = await walk(KB);

// 非 md 附件（.docx/.pdf/.csv/.base…）也能被 wikilink 指向：收集它们的基名，
// 否则「[[文言词语整理表.docx]]」会被误判成断链。
const attachBases = new Set();
async function walkAll(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkAll(full);
    else if (!e.name.endsWith('.md')) attachBases.add(e.name);
  }
}
await walkAll(KB);
const byBase = new Map();
const aliases = new Map(); // alias -> [files]
const contents = new Map();

for (const f of files) {
  const base = path.basename(f, '.md');
  if (!byBase.has(base)) byBase.set(base, []);
  byBase.get(base).push(path.relative(KB, f).split(path.sep).join('/'));
  const text = await readFile(f, 'utf8');
  contents.set(f, text);
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (fm) {
    const block = fm[1];
    const inline = /^aliases:\s*\[(.*)\]\s*$/m.exec(block);
    const list = /^aliases:\s*\r?\n((?:\s*-\s*.+\r?\n?)+)/m.exec(block);
    const vals = inline
      ? inline[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''))
      : list
        ? [...list[1].matchAll(/-\s*(.+)/g)].map((m) => m[1].trim().replace(/^["']|["']$/g, ''))
        : [];
    for (const a of vals.filter(Boolean)) {
      if (!aliases.has(a)) aliases.set(a, []);
      aliases.get(a).push(path.relative(KB, f).split(path.sep).join('/'));
    }
  }
}

const problems = [];

for (const [base, list] of byBase) {
  if (list.length > 1) problems.push(`同名文件 "${base}.md" 出现在：${list.join('、')}`);
}
for (const [a, list] of aliases) {
  if (list.length > 1) problems.push(`alias "${a}" 被多个文件声明：${list.join('、')}`);
}

// 误建空笔记：在 Obsidian 里点击「未解析的链接」会在库根自动新建一个同名空文件，
// 而且它会**抢走**同 id 别名的解析，必须及时清理。
const ROOT_ALLOWED = new Set(['README.md', 'AGENTS.md', '首页.md']);
const emptyNotes = [];
const strayRoot = [];
for (const f of files) {
  const rel = path.relative(KB, f).split(path.sep).join('/');
  const size = statSync(f).size;
  if (size < 20) {
    emptyNotes.push(`${rel}（${size} 字节）`);
    continue;
  }
  if (!rel.includes('/') && !ROOT_ALLOWED.has(rel)) strayRoot.push(rel);
}

// 断链检查：[[target]] 或 [[target|显示文本]]，忽略图片、外部链接、代码块与行内代码。
// Obsidian 会正常渲染代码块里的 [[...]] 为字面量，因此不该算断链。
const CATALOG = path.join(KB, 'index', 'catalog.jsonl');
const knownIds = new Set();
if (existsSync(CATALOG)) {
  for (const line of (await readFile(CATALOG, 'utf8')).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      knownIds.add(JSON.parse(line).id);
    } catch {
      /* 忽略坏行 */
    }
  }
}

const stripCode = (s) =>
  s
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '');

// 只检查「有意建立链接」的层：notes/ 摘要卡、index/ 索引、digests/ 成品、根目录文档。
// chats/ 是对话原文（内容里可能出现 [[world:001]] 这类原始标记），属于正文而非知识库链接，
// 不参与断链检查，但仍参与同名文件与 alias 检查。
const NO_LINK_CHECK = /^chats\//;

let linkCount = 0;
let markdownLinks = 0;
let ghostRisk = 0;
const pending = [];
for (const f of files) {
  const rel = path.relative(KB, f).split(path.sep).join('/');
  if (NO_LINK_CHECK.test(rel)) {
    // chats/ 是对话原文，不参与断链检查；但正文里若出现**未转义**的 [[ ，
    // Obsidian 会把它当成 wikilink，在图谱里生成一堆没有对应文件的幽灵节点。
    // ds-chat-export.mjs 会把它们转义成 \[\[，这里做回归防护。
    const raw = contents.get(f);
    const unescaped = (raw.match(/(?<!\\)\[\[/g) || []).length;
    if (unescaped) {
      ghostRisk += unescaped;
      console.log(`  ⚠ ${rel}：有 ${unescaped} 处未转义的 [[ → 会在图谱里生成幽灵节点（重跑 ds-chat-export.mjs 可修）`);
    }
    continue;
  }
  const text = stripCode(contents.get(f));
  for (const m of text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    // 表格里为了转义竖线会写成 [[X\|别名]]，反斜杠不是路径的一部分
    const target = m[1].trim().replace(/\\+$/, '');
    if (!target || /^https?:/.test(target)) continue;
    linkCount++;
    const bare = path.basename(target);
    if (byBase.has(bare) || aliases.has(bare) || attachBases.has(bare) || existsSync(path.join(KB, target))) continue;
    // 指向已登记但尚未建卡的条目：属于「待建卡提示」，不是错误
    if (/^kb-\d+$/.test(bare) && knownIds.has(bare)) {
      pending.push(`${rel} → [[${target}]]（该条目已登记但还没有摘要卡）`);
      continue;
    }
    problems.push(`断链：${rel} → [[${target}]]`);
  }

  // 「只写 id」的链接（[[kb-0015]]）：靠 aliases 解析，但在 Obsidian 首次索引未就绪或
  // 部分版本上会失败，点击后会在库根新建一个 0 字节空笔记，反过来抢走别名解析。
  const idOnly = text.match(/\[\[kb-\d{4}\]\]/g) || [];
  if (idOnly.length) {
    problems.push(
      `${rel}: 有 ${idOnly.length} 处「只写 id」的链接（${[...new Set(idOnly)].join(' ')}）` +
        '→ 应写成 [[完整文件名|id]]；跑 node tools/fix-id-links.mjs 可自动修',
    );
  }

  // Markdown 链接（表格里用它替代 [[X\|别名]]，避免转义反斜杠被当成路径）
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+?\.(?:md|docx|xlsx|pptx|pdf|csv|base|txt))(?:#[^)]*)?\)/g)) {
    const target = decodeURIComponent(m[1]);
    markdownLinks++;
    if (!existsSync(path.resolve(KB, target)) && !existsSync(path.resolve(path.dirname(f), target))) {
      problems.push(`断链（Markdown）：${rel} → ${target}`);
    }
  }
}

console.log(`扫描 ${files.length} 个 Markdown 文件、${linkCount} 条 wikilink、${markdownLinks} 条 Markdown 链接`);
console.log(`文件名 ${byBase.size} 个 ｜ alias ${aliases.size} 个`);
if (pending.length) {
  console.log(`\n⚠ ${pending.length} 条链接指向尚未建卡的已登记条目（不算错，建卡后自动解析）：`);
  for (const p of pending) console.log(`  · ${p}`);
}
if (emptyNotes.length) {
  console.log(`\n⚠ 疑似误建的空白笔记 ${emptyNotes.length} 个（Obsidian 点击未解析链接会自动新建）：`);
  for (const e of emptyNotes) console.log(`  · ${e}`);
  console.log('  处理：确认无内容后删除；若它占用了某个 kb-XXXX 名称，会抢走同 id 别名的解析。');
}
if (strayRoot.length) {
  console.log(`\n⚠ 库根目录出现非预期笔记：${strayRoot.join('、')}`);
  console.log(`  库根只应有：${[...ROOT_ALLOWED].join('、')}`);
}
if (ghostRisk) {
  console.log(`\n⚠ 对话原文里共 ${ghostRisk} 处未转义的 [[ ：Obsidian 会在图谱中生成幽灵节点。`);
  console.log('  修复：重跑 node tools/ds-chat-export.mjs（它会写入 \\[\\[ ），然后重新 scan。');
}
if (problems.length) {
  console.log(`\n发现 ${problems.length} 个问题：`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exitCode = 1;
} else {
  console.log('\nObsidian 健康检查通过 ✓（无同名文件、无断链、无 alias 冲突）');
}
