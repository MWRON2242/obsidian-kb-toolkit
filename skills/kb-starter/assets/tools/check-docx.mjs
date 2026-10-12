#!/usr/bin/env node
/**
 * check-docx.mjs —— 校验 .docx 是否结构完好，并打印文档大纲
 *
 * 做三件事（都不需要 Word / 任何依赖）：
 *   1. 解 ZIP，确认 OOXML 必需部件齐全、都能解压
 *   2. 对每个 XML 部件做良构性检查（标签配对、无游离尖括号）
 *   3. 抽出正文文本，打印大纲（标题/段落/表格行列数）
 *
 * 用法：node tools/check-docx.mjs <文件.docx> [--text]
 */
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const SHOW_TEXT = process.argv.includes('--text');
if (!file) {
  console.error('用法: node tools/check-docx.mjs <文件.docx> [--text]');
  process.exit(1);
}

const buf = readFileSync(file);

/* ---------- 读 ZIP ---------- */
let eocd = -1;
for (let i = buf.length - 22; i >= 0; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) {
    eocd = i;
    break;
  }
}
if (eocd < 0) {
  console.error('✗ 找不到 ZIP 结尾记录（EOCD）—— 这不是一个合法的 zip/docx');
  process.exit(1);
}
const count = buf.readUInt16LE(eocd + 10);
const cdOff = buf.readUInt32LE(eocd + 16);
const parts = new Map();
let p = cdOff;
for (let k = 0; k < count; k++) {
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const cmtLen = buf.readUInt16LE(p + 32);
  const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
  const compSize = buf.readUInt32LE(p + 20);
  const lho = buf.readUInt32LE(p + 42);
  const method = buf.readUInt16LE(p + 10);
  const lNameLen = buf.readUInt16LE(lho + 26);
  const lExtra = buf.readUInt16LE(lho + 28);
  const dataStart = lho + 30 + lNameLen + lExtra;
  const raw = buf.slice(dataStart, dataStart + compSize);
  let data = null;
  try {
    data = method === 8 ? zlib.inflateRawSync(raw) : raw;
  } catch {
    data = null;
  }
  parts.set(name, data);
  p += 46 + nameLen + extraLen + cmtLen;
}

console.log(`文件：${file}`);
console.log(`大小：${(buf.length / 1024).toFixed(1)} KB　｜　ZIP 条目 ${count} 个\n`);

/* ---------- 必需部件 ---------- */
const REQUIRED = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml'];
console.log('=== 部件清单 ===');
let ok = true;
for (const [name, data] of parts) {
  const mark = data ? '✓' : '✗';
  if (!data) ok = false;
  console.log(`  ${mark} ${name.padEnd(34)} ${data ? data.length + ' B' : '解压失败'}`);
}
for (const r of REQUIRED) {
  if (!parts.has(r)) {
    console.log(`  ✗ 缺少必需部件 ${r}`);
    ok = false;
  }
}

/* ---------- XML 良构性 ---------- */
function wellFormed(xml) {
  const body = xml.replace(/<\?[\s\S]*?\?>/g, '');
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const stack = [];
  let mismatch = 0;
  let m;
  while ((m = re.exec(body))) {
    const close = m[1];
    const tag = m[2];
    const selfClose = m[4];
    if (selfClose === '/') continue;
    if (close === '/') {
      const top = stack.pop();
      if (top !== tag) mismatch++;
    } else stack.push(tag);
  }
  const stray = body.replace(re, '').match(/[<>]/g);
  return { ok: mismatch === 0 && stack.length === 0 && !stray, unclosed: stack.length, mismatch, stray: stray ? stray.length : 0 };
}

console.log('\n=== XML 良构性 ===');
for (const [name, data] of parts) {
  if (!data || !name.endsWith('.xml') && !name.endsWith('.rels')) continue;
  const r = wellFormed(data.toString('utf8'));
  if (!r.ok) ok = false;
  console.log(`  ${r.ok ? '✓' : '✗'} ${name.padEnd(34)} 未闭合 ${r.unclosed}　配对错误 ${r.mismatch}　游离尖括号 ${r.stray}`);
}

/* ---------- 大纲 ---------- */
const doc = parts.get('word/document.xml')?.toString('utf8') || '';
const tblCount = (doc.match(/<w:tbl>/g) || []).length;
const trCount = (doc.match(/<w:tr>/g) || []).length;
const tcCount = (doc.match(/<w:tc>/g) || []).length;
const pCount = (doc.match(/<w:p>/g) || []).length;
console.log('\n=== 结构统计 ===');
console.log(`  表格 ${tblCount} 个　｜　表格行 ${trCount}　｜　单元格 ${tcCount}　｜　段落 ${pCount}`);
console.log(`  表头跨页重复标记：${(doc.match(/<w:tblHeader\/>/g) || []).length} 处`);
console.log(`  页脚引用：${/footerReference/.test(doc) ? '有' : '无'}　｜　页面方向：${/w:orient="landscape"/.test(doc) ? '横向' : '纵向'}`);

const texts = doc
  .split(/<w:p[ >]/)
  .slice(1)
  .map((seg) => seg.replace(/<[^>]+>/g, '').trim())
  .filter(Boolean);
console.log('\n=== 内容大纲 ===');
if (SHOW_TEXT) {
  texts.forEach((t, i) => console.log(`  ${String(i + 1).padStart(3)}. ${t.slice(0, 100)}`));
  console.log(`  （共 ${texts.length} 段）`);
} else {
  texts.slice(0, 12).forEach((t, i) => console.log(`  ${String(i + 1).padStart(3)}. ${t.slice(0, 90)}`));
  console.log(`  … 共 ${texts.length} 段（加 --text 看全部）`);
}

console.log(ok ? '\n结论：docx 结构完好 ✓' : '\n结论：存在问题 ✗');
process.exit(ok ? 0 : 1);
