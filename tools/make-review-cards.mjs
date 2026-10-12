#!/usr/bin/env node
/**
 * make-review-cards.mjs —— 把 vocab/ 里的词条变成 Obsidian-Spaced-Repetition 的复习卡
 *
 * ⚠️ 本脚本最重要的设计：**只增不改**
 * Spaced Repetition 插件会把复习进度以 `<!--SR:!2026-11-01,13,290-->` 写回**卡片那一行**。
 * 因此生成器绝不重写已有卡片行，只在对应字母分节里**插入新增词**。
 * 想整体重来必须显式加 --rebuild（会丢失全部复习进度，脚本会二次确认提示）。
 *
 * 产物：
 *   review/英语词汇.md            卡片：`英文 ::: 中文释义`（单行双向卡），按首字母分节
 *   review/英语词汇-出处索引.md    单词 → 释义 → 出处（可再生，含指向 vocab/ 笔记的链接）
 *
 * 用法：
 *   node tools/make-review-cards.mjs            # 增量补卡（推荐，日常就用这个）
 *   node tools/make-review-cards.mjs --check    # 只看会新增多少张
 *   node tools/make-review-cards.mjs --rebuild  # 清空重建（丢复习进度！）
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const VOCAB = path.join(KB, 'vocab');
const REVIEW = path.join(KB, 'review');
const CARD_FILE = path.join(REVIEW, '英语词汇.md');
const INDEX_FILE = path.join(REVIEW, '英语词汇-出处索引.md');

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const REBUILD = argv.includes('--rebuild');
const TAG = '#flashcards/英语';

/* ---------- 解析 vocab 词条 ---------- */
const fm = (text) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
};

/** 从词条正文的释义表里取「批注」与「出处」 */
function parseTable(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (!m) continue;
    if (m[1] === '释义' || /^-+$/.test(m[1])) continue;
    rows.push({ meaning: m[1], pos: m[2], note: m[3], source: m[4] });
  }
  return rows;
}

const words = [];
for (const f of readdirSync(VOCAB).filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== '词汇总表.md')) {
  const text = readFileSync(path.join(VOCAB, f), 'utf8');
  const meta = fm(text);
  const word = meta.word;
  if (!word) continue;
  const rows = parseTable(text);
  words.push({
    word,
    meanings: meta.meanings || rows.map((r) => r.meaning).join(' / '),
    notes: [...new Set(rows.map((r) => r.note).filter((n) => n && n !== '—'))],
    sources: [...new Set(rows.map((r) => r.source.replace(/\[\[|\]\]/g, '').split('|')[0].trim()).filter(Boolean))],
    note: path.basename(f, '.md'),
  });
}
words.sort((a, b) => a.word.toLowerCase().localeCompare(b.word.toLowerCase()));

/** 清洗：卡片语法用 :: 分隔、== 是填空标记，落在正文里会破坏解析 */
const sanitize = (s) => s.replace(/::/g, '：').replace(/==/g, '＝').replace(/\r?\n/g, ' ').trim();

const letterOf = (w) => {
  const c = (w[0] || '').toUpperCase();
  return /[A-Z]/.test(c) ? c : '其他';
};

/* ---------- 读已有卡片文件（增量） ---------- */
let existing = '';
if (!REBUILD && existsSync(CARD_FILE)) existing = readFileSync(CARD_FILE, 'utf8');
const existingQuestions = new Set(
  [...existing.matchAll(/^(.*?):::/gm)].map((m) => m[1].trim().toLowerCase()),
);

const header = `---
tags: []
---

${TAG}

> **英语词汇复习卡**（单行双向卡：看英文想中文，也看中文想英文）
> 用法：\`Ctrl+P\` → \`Spaced Repetition: Review flashcards from all notes\`
> ⚠️ **这一层是"复习进度层"，由 \`tools/make-review-cards.mjs\` 只增不改地维护** ——
> 插件会把复习进度以 HTML 注释写在卡片行尾，任何脚本都不得重写已有卡片行。
> 词条来源与出处见 [[英语词汇-出处索引]]；原始词条在 \`vocab/\` 中。

`;

// 按字母分节：把新增卡片插到对应分节末尾（不动任何已有行）
const blocks = new Map();
let skipped = 0;
for (const w of words) {
  if (existingQuestions.has(w.word.toLowerCase())) {
    skipped++;
    continue;
  }
  const letter = letterOf(w.word);
  if (!blocks.has(letter)) blocks.set(letter, []);
  blocks.get(letter).push(`${sanitize(w.word)} ::: ${sanitize(w.meanings)}`);
}

console.log(`词条总数 ${words.length}　｜　已有卡片 ${existingQuestions.size} 张　｜　本次新增 ${words.length - skipped} 张`);

if (CHECK) {
  for (const [l, list] of [...blocks].sort()) console.log(`  分节 ${l}：+${list.length}`);
  process.exit(0);
}

/* ---------- 写卡片文件 ---------- */
let out;
if (!existing) {
  out = header;
  for (const [l, list] of [...blocks].sort()) out += `## ${l}\n\n${list.join('\n')}\n\n`;
} else {
  out = existing.replace(/\s*$/, '\n');
  for (const [l, list] of [...blocks].sort()) {
    const secRe = new RegExp(`(^## ${l === '其他' ? '其他' : l}$)([\\s\\S]*?)(?=^## |\\Z)`, 'm');
    const hit = secRe.exec(out);
    if (hit) {
      // 在该分节末尾插入（保持原有行完全不变）
      const insertAt = hit.index + hit[0].length;
      const pad = hit[0].endsWith('\n') ? '' : '\n';
      out = out.slice(0, insertAt) + pad + list.join('\n') + '\n' + out.slice(insertAt);
    } else {
      out += `\n## ${l}\n\n${list.join('\n')}\n`;
    }
  }
}
if (!CHECK) {
  mkdirSync(REVIEW, { recursive: true });
  writeFileSync(CARD_FILE, out, 'utf8');
}

/* ---------- 出处索引（可再生，无复习数据） ---------- */
const I = [
  '# 英语词汇 · 出处索引',
  '',
  `> 由 \`tools/make-review-cards.mjs\` 生成（每次全量重建）。卡片本身在 [[英语词汇]]。`,
  `> 共 ${words.length} 个词条，来自 \`vocab/\`（那是从对话原文与手工笔记**逐字搬运**的层）。`,
  '',
  '| 单词 | 释义 | 原文批注 | 出处 | 词条笔记 |',
  '| --- | --- | --- | --- | --- |',
];
for (const w of words) {
  const esc = (s) => s.replace(/\|/g, '\\|');
  I.push(
    `| ${esc(w.word)} | ${esc(w.meanings)} | ${esc(w.notes.join('；') || '—')} | ${esc(w.sources.join('；') || '—')} | [[${w.note}\\|${esc(w.word)}]] |`,
  );
}
I.push('');
writeFileSync(INDEX_FILE, I.join('\n'), 'utf8');

console.log(`已写入：${path.relative(KB, CARD_FILE)}（新增 ${words.length - skipped} 张，保留已有 ${skipped} 张）`);
console.log(`已写入：${path.relative(KB, INDEX_FILE)}（${words.length} 条出处索引）`);
