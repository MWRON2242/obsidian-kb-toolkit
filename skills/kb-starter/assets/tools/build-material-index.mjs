#!/usr/bin/env node
/**
 * build-material-index.mjs —— 为 materials/ 生成「人读总表」与「Bases 视图」
 *
 * 产物：
 *   1. materials/素材库总表.md —— 按类别与会话分组的静态索引（不依赖任何插件，必定可读）
 *   2. 素材库.base            —— Obsidian 1.9 自带 Bases 的筛选视图（表格/卡片墙）
 *
 * 只读 materials/*.md 的 front matter，不改动条目内容。
 *
 * 用法：node tools/build-material-index.mjs
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const DIR = path.join(KB, 'materials');
if (!existsSync(DIR)) {
  console.error('还没有 materials/，请先运行 node tools/extract-materials.mjs');
  process.exit(1);
}

const fm = (text) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
};

const items = [];
for (const f of readdirSync(DIR)) {
  if (!f.endsWith('.md') || f.startsWith('_')) continue;
  const meta = fm(readFileSync(path.join(DIR, f), 'utf8'));
  if (meta.kb_material !== 'true') continue;
  items.push({ file: f, ...meta });
}

const byKind = {};
for (const it of items) (byKind[it.kind] = byKind[it.kind] || []).push(it);
const byChat = {};
for (const it of items) (byChat[it.from_chat] = byChat[it.from_chat] || []).push(it);
const nHigh = items.filter((i) => i.conf === 'high').length;

const L = [];
L.push('# 素材库总表');
L.push('');
L.push(`> 由 \`tools/build-material-index.mjs\` 生成。**每个条目的正文都是从对话原文逐字搬运**，未经改写。`);
L.push(`> 共 **${items.length}** 条：${Object.entries(byKind).map(([k, v]) => `${k} ${v.length}`).join('、')}　｜　高置信 ${nHigh} 条`);
L.push('> 生成时间：' + new Date().toISOString().slice(0, 16).replace('T', ' '));
L.push('');
L.push('**怎么用**：左侧文件树打开 `materials/` 直接看条目；想按类别/会话/置信度筛选，打开 `素材库.base`（Obsidian 1.9 自带 Bases）。');
L.push('');
L.push('| 类别 | 条数 | 说明 |');
L.push('| --- | --- | --- |');
L.push(`| 素材 | ${(byKind['素材'] || []).length} | 可直接用于作文的素材段落（多含"适用主题/适用角度"） |`);
L.push(`| 范文 | ${(byKind['范文'] || []).length} | 完整范文或范文段落 |`);
L.push('');
L.push('## 按会话浏览');
L.push('');
L.push('| 会话 | 素材 | 范文 | 合计 |');
L.push('| --- | --- | --- | --- |');
for (const [chat, list] of Object.entries(byChat).sort((a, b) => b[1].length - a[1].length)) {
  const s = list.filter((i) => i.kind === '素材').length;
  const f = list.filter((i) => i.kind === '范文').length;
  L.push(`| ${chat} | ${s} | ${f} | ${list.length} |`);
}
L.push('');

for (const kind of ['素材', '范文']) {
  const list = byKind[kind] || [];
  if (!list.length) continue;
  L.push(`## ${kind}（${list.length}）`);
  L.push('');
  for (const [chat, group] of Object.entries(
    list.reduce((acc, i) => ((acc[i.from_chat] = acc[i.from_chat] || []).push(i), acc), {}),
  ).sort((a, b) => b[1].length - a[1].length)) {
    L.push(`### ${chat}（${group.length}）`);
    L.push('');
    for (const it of group.sort((a, b) => String(a.file).localeCompare(String(b.file)))) {
      const conf = it.conf === 'high' ? '' : `　\`conf: ${it.conf}\``;
      const sec = it.section && !it.section.startsWith('（') ? `　<sub>${it.section}</sub>` : '';
      L.push(`- [[${it.file.replace(/\.md$/, '')}|${it.title}]]${sec}${conf}`);
    }
    L.push('');
  }
}

const low = items.filter((i) => i.conf !== 'high');
if (low.length) {
  L.push(`## ⚠️ 待人工确认（conf 非 high，${low.length} 条）`);
  L.push('');
  L.push('这些条目的结构不完全规整（或来自整轮兜底），**内容仍是逐字原文**，只是分类可能需要你过一眼：');
  L.push('');
  for (const it of low) L.push(`- [[${it.file.replace(/\.md$/, '')}|${it.title}]]　<sub>${it.from_chat} · 第 ${it.round} 轮</sub>`);
  L.push('');
}

writeFileSync(path.join(DIR, '素材库总表.md'), L.join('\n'), 'utf8');

/* ---------- Bases 视图 ---------- */
const base = [
  '# Obsidian Bases 视图（1.9+ 自带）。若某列报错，用 Bases 界面点选调整即可。',
  'filters:',
  '  and:',
  '    - file.inFolder("materials")',
  'views:',
  '  - type: table',
  '    name: 全部条目',
  '    order:',
  '      - title',
  '      - kind',
  '      - conf',
  '      - from_chat',
  '      - round',
  '      - section',
  '  - type: table',
  '    name: 高置信素材',
  '    filters:',
  '      and:',
  '        - conf == "high"',
  '        - kind == "素材"',
  '    order:',
  '      - title',
  '      - from_chat',
  '      - section',
  '  - type: table',
  '    name: 范文',
  '    filters:',
  '      and:',
  '        - kind == "范文"',
  '    order:',
  '      - title',
  '      - from_chat',
  '      - conf',
  '  - type: cards',
  '    name: 素材卡片墙',
  '    order:',
  '      - title',
  '      - kind',
  '      - from_chat',
  '  - type: table',
  '    name: 待人工确认',
  '    filters:',
  '      and:',
  '        - conf != "high"',
  '    order:',
  '      - title',
  '      - kind',
  '      - conf',
  '      - from_chat',
  '',
];
writeFileSync(path.join(KB, '素材库.base'), base.join('\n'), 'utf8');

console.log(`已生成 materials/素材库总表.md（${items.length} 条，其中高置信 ${nHigh} 条）`);
console.log(`已生成 素材库.base（5 个视图：全部 / 高置信素材 / 范文 / 卡片墙 / 待人工确认）`);
