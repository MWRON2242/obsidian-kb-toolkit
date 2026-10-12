#!/usr/bin/env node
/**
 * digest-essay.mjs —— 汇总所有「语文作文」相关卡片，生成一份可打印/可背的素材总表
 *
 * 这是**派生文档**（derived）：内容全部来自 notes/ 摘要卡，随时可重新生成，不要手工改。
 * 输出：digests/语文作文-素材与立意总表.md
 *
 * 用法：
 *   node tools/digest-essay.mjs
 *   node tools/digest-essay.mjs --tags=作文,素材     # 自定义筛选标签（默认：作文）
 *   node tools/digest-essay.mjs --out=digests/xxx.md
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.find((a) => a.startsWith(`${n}=`)) || `${n}=${d}`).split('=')[1];
const FILTER_TAGS = arg('--tags', '作文').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = path.join(KB, arg('--out', 'digests/语文作文-素材与立意总表.md'));

const NOTES = path.join(KB, 'notes');
const records = readFileSync(path.join(KB, 'index', 'catalog.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));

function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return {};
  const fields = {};
  let current = null;
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (kv) {
      current = kv[1];
      let v = kv[2].trim();
      if (v.startsWith('[') && v.endsWith(']')) {
        fields[current] = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      } else {
        fields[current] = v.replace(/^["']|["']$/g, '');
      }
      continue;
    }
    const li = /^\s*-\s+(.*)$/.exec(raw);
    if (li && current) {
      if (!Array.isArray(fields[current])) fields[current] = fields[current] ? [fields[current]] : [];
      fields[current].push(li[1].trim().replace(/^["']|["']$/g, ''));
    }
  }
  return fields;
}

const noteByName = new Map();
for (const f of existsSync(NOTES) ? readdirSync(NOTES) : []) {
  if (!f.endsWith('.md')) continue;
  noteByName.set(f.split('-').slice(0, 2).join('-'), { file: f, ...parseFrontMatter(readFileSync(path.join(NOTES, f), 'utf8')) });
}

const picked = [];
for (const rec of records) {
  const note = noteByName.get(rec.id);
  if (!note) continue;
  const tags = note.tags || [];
  if (!FILTER_TAGS.some((t) => tags.includes(t))) continue;
  // 分类：讲评/方法 > 范文 > 素材 > 其他
  const kind = tags.includes('讲评') || tags.includes('模板')
    ? '方法与讲评'
    : tags.includes('范文')
      ? '考场范文'
      : tags.includes('素材')
        ? '素材整理'
        : '其他';
  picked.push({ id: rec.id, rec, note, tags, kind });
}

const order = ['方法与讲评', '素材整理', '考场范文', '其他'];
picked.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.id.localeCompare(b.id));

const lines = [];
lines.push('# 语文作文 · 素材与立意总表');
lines.push('');
lines.push(`> **派生文档**，由 \`tools/digest-essay.mjs\` 汇总 \`notes/\` 里带 ${FILTER_TAGS.map((t) => '`' + t + '`').join(' / ')} 标签的摘要卡生成。`);
lines.push(`> 生成时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')}　｜　收录 ${picked.length} 张卡片`);
lines.push('> **不要手工编辑本文件**；要改内容请改对应摘要卡，然后重跑生成命令。');
lines.push('');
lines.push('**溯源规则**：所有内容都能回到摘要卡，摘要卡能回到原件或对话原文（`chats/`）。引用时请以卡片 front matter 里的 `source` 为准。');
lines.push('');

const kinds = [...new Set(picked.map((p) => p.kind))];
lines.push('## 目录');
lines.push('');
for (const k of kinds) {
  const list = picked.filter((p) => p.kind === k);
  lines.push(`### ${k}（${list.length}）`);
  lines.push('');
  lines.push('| ID | 卡片 | 一句话 | 标签 |');
  lines.push('| --- | --- | --- | --- |');
  for (const p of list) {
    const card = p.note.file.replace(/\.md$/, '');
    const label = (p.note.title || p.rec.title).replace(/^\d{4}-\d{2}-\d{2}-/, '');
    // 表格里用 Markdown 链接而不是 `[[X\|别名]]`：后者转义用的反斜杠会被部分解析器
    // 当作路径的一部分，点击时提示「文件或文件夹不存在」。
    lines.push(`| ${p.id} | [${label}](notes/${p.note.file}) | ${p.note.summary || '—'} | ${p.tags.map((t) => '#' + t).join(' ')} |`);
  }
  lines.push('');
}

lines.push('## 可直接引用的金句');
lines.push('');
let quoteCount = 0;
for (const p of picked) {
  const qs = Array.isArray(p.note.quotes) ? p.note.quotes : [];
  if (!qs.length) continue;
  lines.push(`**${p.id}　${(p.note.title || '').replace(/^\d{4}-\d{2}-\d{2}-/, '')}**`);
  for (const q of qs) {
    lines.push(`- ${q}`);
    quoteCount++;
  }
  lines.push('');
}
if (!quoteCount) lines.push('（暂无金句）\n');

lines.push('## 素材与立意要点');
lines.push('');
for (const p of picked) {
  const kps = Array.isArray(p.note.key_points) ? p.note.key_points : [];
  if (!kps.length) continue;
  lines.push(`### ${p.id}　${(p.note.title || '').replace(/^\d{4}-\d{2}-\d{2}-/, '')}`);
  lines.push('');
  for (const k of kps) lines.push(`- ${k}`);
  lines.push('');
  lines.push(`<sub>来源：\`${p.rec.source}\`　·　卡片：[[${p.note.file.replace(/\.md$/, '')}]]</sub>`);
  lines.push('');
}

lines.push('---');
lines.push('');
lines.push('## 如何更新');
lines.push('');
lines.push('```powershell');
lines.push('node tools/digest-essay.mjs');
lines.push('node tools/digest-essay.mjs --tags=作文,素材');
lines.push('```');
lines.push('');

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, lines.join('\n'), 'utf8');

console.log(`已生成：${path.relative(KB, OUT)}`);
console.log(`收录卡片 ${picked.length} 张（${kinds.map((k) => `${k} ${picked.filter((p) => p.kind === k).length}`).join('、')}）`);
console.log(`金句 ${quoteCount} 条，素材要点 ${picked.reduce((a, p) => a + (Array.isArray(p.note.key_points) ? p.note.key_points.length : 0), 0)} 条`);
