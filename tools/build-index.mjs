#!/usr/bin/env node
/**
 * build-index.mjs —— 由 catalog + notes 生成人读索引 index/INDEX.md
 *
 * catalog 是机器可读层，本文件是它的人读投影。随时可重建，不要手工编辑 INDEX.md。
 *
 * 用法：node tools/build-index.mjs
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const CATALOG = path.join(KB, 'index', 'catalog.jsonl');
const NOTES = path.join(KB, 'notes');
const OUT = path.join(KB, 'index', 'INDEX.md');

const records = (await readFile(CATALOG, 'utf8'))
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const noteFiles = existsSync(NOTES) ? (await readdir(NOTES)).filter((f) => f.endsWith('.md')) : [];
const noteById = new Map(noteFiles.map((f) => [f.split('-').slice(0, 2).join('-'), f]));

// 摘要一句话：从卡片 front matter 的 summary 取
const summaries = new Map();
for (const f of noteFiles) {
  const text = await readFile(path.join(NOTES, f), 'utf8');
  const m = /^summary:\s*(.+)$/m.exec(text);
  summaries.set(f.split('-').slice(0, 2).join('-'), m ? m[1].trim() : '');
}

const byStatus = {};
const byType = {};
const byTag = {};
for (const r of records) {
  byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  byType[r.source_type] = (byType[r.source_type] || 0) + 1;
  for (const t of r.tags || []) byTag[t] = (byTag[t] || 0) + 1;
}

const fmt = (obj) =>
  Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join('　·　');

const groups = new Map();
for (const r of records) {
  const key = r.label || r.root || '未分组';
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const lines = [];
lines.push('# 知识库总索引');
lines.push('');
lines.push(`> 由 \`tools/build-index.mjs\` 自动生成，最后更新：${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
lines.push('> **请勿手工编辑本文件**；改动请在 catalog / notes 层进行，然后重新生成。');
lines.push('');
lines.push(`共 **${records.length}** 条登记，**${records.filter((r) => r.note).length}** 条已有摘要卡。`);
lines.push('');
lines.push(`- 类型：${fmt(byType)}`);
lines.push(`- 状态：${fmt(byStatus)}`);
lines.push(`- 标签：${fmt(byTag)}`);
lines.push('');

for (const [group, recs] of groups) {
  recs.sort((a, b) => a.id.localeCompare(b.id));
  lines.push(`## ${group}（${recs.length}）`);
  lines.push('');
  lines.push('| ID | 标题 | 标签 | 状态 | 摘要 | 原件 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of recs) {
    const note = noteById.get(r.id);
    // 表格里不要用「别名 + 转义竖线」的 wikilink：`[[X\|别名]]` 会被某些解析器把反斜杠
    // 当成路径的一部分，点击时报「文件或文件夹不存在」。改用 Markdown 链接（无需转义，
    // Obsidian 同样识别为内部链接）。
    const title = note ? `[${r.title}](notes/${note})` : r.title;
    const origin = r.source.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:');
    lines.push(
      `| ${r.id} | ${title} | ${(r.tags || []).map((t) => '#' + t).join(' ') || '—'} | ${r.status} | ${summaries.get(r.id) || '—'} | \`${origin}\` |`,
    );
  }
  lines.push('');
}

const noNote = records.filter((r) => !r.note);
if (noNote.length) {
  lines.push('## 待补摘要卡');
  lines.push('');
  lines.push(`${noNote.length} 条已登记但还没有摘要卡：`);
  lines.push('');
  lines.push(noNote.map((r) => `${r.id}（${r.title}）`).join('　·　'));
  lines.push('');
}

await writeFile(OUT, lines.join('\n'), 'utf8');
console.log(`已生成 index/INDEX.md：${records.length} 条登记 / ${records.filter((r) => r.note).length} 张卡片 / ${groups.size} 个分组`);
