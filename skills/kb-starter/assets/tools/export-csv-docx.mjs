#!/usr/bin/env node
/**
 * export-csv-docx.mjs —— 把「词语 / 例句 / 释义」类 CSV 整理成排版好的 Word 文档
 *
 * 相比直接看 CSV，文档做了这些可读性处理：
 *   · A4 页面、统一表头、表头跨页重复、斑马纹
 *   · 三列宽度按内容分配；词语加粗、例句用楷体、释义用宋体
 *   · 前置**一词多义速览**（同一个词出现多次时把各义项与例句并排）
 *   · 文末统计与阅读提示；页脚页码
 *
 * 用法：
 *   node tools/export-csv-docx.mjs --in=x.csv --out=x.docx --title="文言词语整理表" \
 *        [--word-col=词语] [--example-col=例句] [--meaning-col=文中释义] [--note="..."]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildDocx } from './lib-docx.mjs';

const argv = process.argv.slice(2);
const opt = (n, d = '') => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const IN = opt('in');
const OUT = opt('out');
const TITLE = opt('title', '整理表');
const WCOL = opt('word-col', '词语');
const ECOL = opt('example-col', '例句');
const MCOL = opt('meaning-col', '文中释义');
const NOTE = opt('note');
if (!IN || !OUT) {
  console.error('用法: node tools/export-csv-docx.mjs --in=a.csv --out=a.docx --title="标题"');
  process.exit(1);
}

/* ---------- CSV 解析（支持引号包裹与 "" 转义） ---------- */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  const s = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const rows = parseCsv(readFileSync(IN, 'utf8'));
const header = rows[0].map((h) => h.trim());
const idx = { w: header.indexOf(WCOL), e: header.indexOf(ECOL), m: header.indexOf(MCOL) };
if (idx.w < 0 || idx.e < 0 || idx.m < 0) {
  console.error(`CSV 表头里找不到指定列。实际表头：${header.join(' | ')}`);
  process.exit(1);
}
const items = rows.slice(1).map((r) => ({ w: (r[idx.w] || '').trim(), e: (r[idx.e] || '').trim(), m: (r[idx.m] || '').trim() })).filter((x) => x.w);

/* ---------- 一词多义 ---------- */
const byWord = new Map();
for (const it of items) {
  if (!byWord.has(it.w)) byWord.set(it.w, []);
  byWord.get(it.w).push(it);
}
const multi = [...byWord.entries()].filter(([, v]) => v.length > 1);
const meanSet = new Set(items.map((x) => `${x.w}→${x.m}`));

/* ---------- 组装文档 ---------- */
const today = new Date().toISOString().slice(0, 10);
const blocks = [];

blocks.push({ type: 'title', text: TITLE });
blocks.push({
  type: 'small',
  text: `来源：${path.basename(IN)}　·　共 ${items.length} 个词条（唯一词 ${byWord.size} 个，其中 ${multi.length} 个出现两次以上）　·　整理日期 ${today}`,
  al: 'center',
});
blocks.push({
  type: 'p',
  text:
    (NOTE ||
      '本表按原文行文顺序排列。「文中释义」是这些词在该文语境下的意思，不等于词典里的全部义项；同一词出现两次时，注意两处释义的差别。') +
    '',
});

if (multi.length) {
  blocks.push({ type: 'h1', text: `一、一词多义速览（${multi.length} 个词）` });
  blocks.push({
    type: 'small',
    text: '同一个词在文中出现两次以上，且释义未必相同 —— 这是文言文最需要盯住的地方。',
  });
  blocks.push({
    type: 'table',
    widths: [1.8, 2.0, 6.1, 6.0],
    header: ['词语', '次数', '例句', '文中释义'],
    zebra: true,
    rows: multi.map(([w, list]) => [
      { t: w, b: true, al: 'center' },
      { t: String(list.length), al: 'center' },
      list.map((x) => ({ t: `· ${x.e}`, font: 'kai' })),
      list.map((x) => x.m).join('　/　'),
    ]),
  });
}

blocks.push({ type: 'h1', text: `${multi.length ? '二' : '一'}、词语对照表（${items.length} 条）` });
blocks.push({
  type: 'table',
  widths: [1.1, 2.0, 6.4, 6.4],
  header: ['序号', '词语', '例句', '文中释义'],
  zebra: true,
  rows: items.map((it, i) => [
    { t: String(i + 1), al: 'center', sz: 9.5, color: '808080' },
    { t: it.w, b: true, al: 'left' },
    { t: it.e, font: 'kai' },
    { t: it.m },
  ]),
});

blocks.push({ type: 'h1', text: `${multi.length ? '三' : '二'}、统计与用法` });
const stats = [
  `词条总数：${items.length} 条；唯一词 ${byWord.size} 个；一词多义 ${multi.length} 个（${multi.map(([w]) => w).join('、') || '无'}）。`,
  `不同「词语 + 释义」组合：${meanSet.size} 种 —— 组合数少于词条数，说明有词在不同句子里取了相同的意思。`,
  '例句多为原文片段，个别做了省略（如“阴受……旨”），引用时请回原文核对完整句子。',
  '建议背诵方式：先遮住「文中释义」列自测，再对着例句回忆该词在句中的意思；多义词重点区分两处语境差异。',
];
for (const s of stats) blocks.push({ type: 'p', text: `· ${s}`, indent: 340, hanging: 170 });

/* ---------- 输出 ---------- */
const buf = buildDocx({ title: TITLE, footer: TITLE, blocks });
const dir = path.dirname(OUT);
mkdirSync(dir, { recursive: true });
writeFileSync(OUT, buf);

console.log(`已生成：${OUT}`);
console.log(`  大小 ${(buf.length / 1024).toFixed(1)} KB　｜　${items.length} 条词条　｜　唯一词 ${byWord.size} 个　｜　一词多义 ${multi.length} 个`);
console.log(`  一词多义：${multi.map(([w, l]) => `${w}(${l.length})`).join('、') || '无'}`);
