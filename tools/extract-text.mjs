#!/usr/bin/env node
/**
 * extract-text.mjs —— 从原件抽取纯文本到 cache/text/<id>.txt
 *
 * 覆盖格式：
 *   .pdf          → unpdf（内置 pdfjs，纯 JS，无外部程序）
 *   .docx/.pptx/.xlsx → 内置极简 ZIP + XML 解析（不调用 Word）
 *   .txt/.md      → 直接读取（含 UTF-8 / GBK 自动判别）
 *   .epub         → ZIP + HTML 去标签
 *
 * 绝不改动原件；只写 cache/text/ 与 index/catalog.jsonl 的 text/status 字段。
 *
 * 用法：
 *   node tools/extract-text.mjs --all              # 处理 index/extract-queue.json
 *   node tools/extract-text.mjs --all --force      # 忽略已有缓存，全部重抽
 *   node tools/extract-text.mjs --id=kb-0007       # 只抽一篇
 *   node tools/extract-text.mjs --list             # 只看队列，不执行
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const CATALOG = path.join(KB, 'index', 'catalog.jsonl');
const QUEUE = path.join(KB, 'index', 'extract-queue.json');
const TEXTDIR = path.join(KB, 'cache', 'text');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const hit = argv.find((a) => a.startsWith(`${n}=`));
  return hit ? hit.slice(n.length + 1) : null;
};

const EMPTY_THRESHOLD = 30; // 少于这么多字符视为「无文本层」

/* ---------------- 极简 ZIP 读取（仅需 deflate / store） ---------------- */
function zipEntries(buf) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP/OOXML 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const map = new Map();
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    map.set(name, { method, csize, usize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return map;
}

function zipRead(buf, entry) {
  const lo = entry.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('本地 ZIP 头损坏');
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.csize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`不支持的压缩方式 ${entry.method}`);
}

/* ---------------- XML / HTML → 纯文本 ---------------- */
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function xmlToPlain(xml) {
  let s = xml;
  s = s.replace(/<w:tab\s*\/>/g, '\t');
  s = s.replace(/<w:br\s*\/>|<a:br\s*\/>/g, '\n');
  s = s.replace(/<\/(w:p|a:p|w:tr|w:tc)>/g, '\n');
  s = s.replace(/<\/(h[1-6]|p|div|li|tr|br)>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  return decodeEntities(s);
}

function normalize(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 中文文本增强清洗：
 *  1) 去掉汉字之间被 PDF 排版拆出来的空格（「以 自 我 为 基」→「以自我为基」），
 *     否则中文检索几乎必然漏召；
 *  2) 丢掉重复 4 次以上的整行（答题卡边框、页眉页脚这类模板文字）。
 */
function enhanceChinese(text) {
  const cjk = '\\u3400-\\u9fff\\u3000-\\u303f\\uff00-\\uffef';
  let s = text;
  let prev;
  do {
    prev = s;
    s = s.replace(new RegExp(`([${cjk}])[ \\t]+(?=[${cjk}])`, 'g'), '$1');
  } while (s !== prev);

  const counts = new Map();
  for (const line of s.split('\n')) {
    const k = line.trim();
    if (k.length >= 2) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const boiler = new Set([...counts].filter(([, n]) => n >= 4).map(([k]) => k));
  if (boiler.size) {
    s = s
      .split('\n')
      .filter((l) => !boiler.has(l.trim()))
      .join('\n');
  }
  return normalize(s);
}

/**
 * 乱码嗅探：有些 PDF 的内嵌字体没有 ToUnicode 映射，pdfjs 会「成功」抽出
 * 一大堆字符，但全是错位字形（看上去像亚美尼亚文/古吉拉特文）。
 * 这类「假成功」必须被识别出来标成 needs-ocr，否则摘要卡会基于垃圾内容编写。
 * 判据：非空白字符里，属于「中日韩 + 全角标点 + 拉丁字母数字」的占比低于 50%。
 */
function looksMojibake(text) {
  const nonSpace = text.replace(/\s/g, '');
  if (nonSpace.length < 50) return false;
  const ok = (
    nonSpace.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffefA-Za-z0-9]/g) || []
  ).length;
  return ok / nonSpace.length < 0.5;
}

/* ---------------- 分格式抽取 ---------------- */
async function extractPdf(file) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const data = new Uint8Array(await readFile(file));
  const pdf = await getDocumentProxy(data);
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  const plain = Array.isArray(text) ? text.join('\n') : text;
  return { text: normalize(plain || ''), pages: totalPages };
}

function extractDocx(buf, entries) {
  const parts = [...entries.keys()]
    .filter((n) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(n))
    .sort((a, b) => (a.includes('document') ? -1 : b.includes('document') ? 1 : a.localeCompare(b)));
  const chunks = parts.map((n) => xmlToPlain(zipRead(buf, entries.get(n)).toString('utf8')));
  return { text: normalize(chunks.join('\n')) };
}

function extractPptx(buf, entries) {
  const slides = [...entries.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  const chunks = slides.map((n, i) => {
    const body = xmlToPlain(zipRead(buf, entries.get(n)).toString('utf8'));
    return `--- 第 ${i + 1} 页 ---\n${body}`;
  });
  const notes = [...entries.keys()]
    .filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  const noteChunks = notes.map((n, i) => {
    const body = xmlToPlain(zipRead(buf, entries.get(n)).toString('utf8'));
    return `--- 备注 ${i + 1} ---\n${body}`;
  });
  return { text: normalize([...chunks, ...noteChunks].join('\n\n')) };
}

function extractXlsx(buf, entries) {
  let shared = [];
  if (entries.has('xl/sharedStrings.xml')) {
    const xml = zipRead(buf, entries.get('xl/sharedStrings.xml')).toString('utf8');
    shared = [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
      [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeEntities(t[1])).join(''),
    );
  }
  const sheets = [...entries.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  const out = [];
  for (const [i, name] of sheets.entries()) {
    const xml = zipRead(buf, entries.get(name)).toString('utf8');
    out.push(`--- 工作表 ${i + 1} ---`);
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = c[1];
        const inner = c[2];
        const t = (attrs.match(/t="([^"]+)"/) || [])[1];
        if (t === 'inlineStr') {
          const v = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1])).join('');
          cells.push(v);
        } else {
          const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] ?? '';
          cells.push(t === 's' ? shared[Number(v)] ?? '' : decodeEntities(v));
        }
      }
      const line = cells.join('\t').replace(/\t+$/, '');
      if (line.replace(/\t/g, '').trim()) out.push(line);
    }
  }
  return { text: normalize(out.join('\n')) };
}

function extractEpub(buf, entries) {
  const docs = [...entries.keys()]
    .filter((n) => /\.(x?html?|htm)$/i.test(n))
    .sort();
  const chunks = docs.map((n) => xmlToPlain(zipRead(buf, entries.get(n)).toString('utf8')));
  return { text: normalize(chunks.join('\n\n')) };
}

function decodeTextFile(buf) {
  let s = buf.toString('utf8');
  const bad = (s.match(/\uFFFD/g) || []).length;
  if (bad > 0 && bad / Math.max(s.length, 1) > 0.002) {
    try {
      s = new TextDecoder('gbk').decode(buf);
    } catch {
      /* 该 Node 构建无 GBK 支持，保留 UTF-8 结果 */
    }
  }
  return { text: normalize(s.replace(/^\uFEFF/, '')) };
}

async function extract(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') return { ...(await extractPdf(file)), kind: 'pdf' };

  if (['.docx', '.pptx', '.xlsx', '.epub'].includes(ext)) {
    const buf = await readFile(file);
    const entries = zipEntries(buf);
    if (ext === '.docx') return { ...extractDocx(buf, entries), kind: 'zip-xml' };
    if (ext === '.pptx') return { ...extractPptx(buf, entries), kind: 'zip-xml' };
    if (ext === '.xlsx') return { ...extractXlsx(buf, entries), kind: 'zip-xml' };
    return { ...extractEpub(buf, entries), kind: 'zip-xml' };
  }

  if (['.txt', '.md', '.csv', '.json'].includes(ext)) {
    return { ...decodeTextFile(await readFile(file)), kind: 'text' };
  }

  // .doc / .xls / .ppt 等旧二进制格式无法本地解析
  if (['.doc', '.xls', '.ppt'].includes(ext)) {
    throw new Error('旧版二进制 Office 格式，需先另存为新格式');
  }
  throw new Error(`不支持的格式 ${ext}`);
}

/* ---------------- 主流程 ---------------- */
async function loadCatalog() {
  const txt = await readFile(CATALOG, 'utf8');
  return txt
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

async function saveCatalog(records) {
  await writeFile(CATALOG, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

const onlyId = opt('--id');
const force = flag('--force');

let targets = [];
if (onlyId) {
  targets = [{ id: onlyId }];
} else {
  if (!existsSync(QUEUE)) {
    console.error('没有 index/extract-queue.json，请先运行 node tools/scan.mjs');
    process.exit(1);
  }
  const q = JSON.parse(await readFile(QUEUE, 'utf8'));
  targets = q.items || [];
}

const records = await loadCatalog();
const byId = new Map(records.map((r) => [r.id, r]));
await mkdir(TEXTDIR, { recursive: true });

console.log(`待处理 ${targets.length} 项${force ? '（--force 忽略缓存）' : ''}\n`);
const report = [];
let ok = 0;
let empty = 0;
let failed = 0;

for (const [i, item] of targets.entries()) {
  const rec = byId.get(item.id);
  const source = rec?.source || item.source;
  if (!rec || !source) {
    console.log(`[${i + 1}/${targets.length}] ${item.id} 不在 catalog 中，跳过`);
    continue;
  }
  const outPath = path.join(TEXTDIR, `${rec.id}.txt`);
  if (!force && existsSync(outPath)) {
    const size = (await readFile(outPath, 'utf8')).length;
    if (size >= EMPTY_THRESHOLD) {
      console.log(`[${i + 1}/${targets.length}] ${rec.id} 已有缓存 ${size} 字，跳过`);
      rec.text = `cache/text/${rec.id}.txt`;
      ok++;
      report.push({ id: rec.id, chars: size, state: 'cached' });
      continue;
    }
  }

  const label = path.basename(source);
  try {
    const raw = await extract(source);
    // .txt/.md 是用户手写的纯文本，不做去重与空格合并，避免改动原意
    const text = raw.kind === 'text' ? raw.text : enhanceChinese(raw.text);
    const { pages, kind } = raw;
    const mojibake = kind !== 'text' && looksMojibake(text);
    await writeFile(outPath, text + '\n', 'utf8');
    if (text.length < EMPTY_THRESHOLD || mojibake) {
      rec.status = 'needs-ocr';
      rec.text = null;
      empty++;
      const why = mojibake
        ? `乱码（字形映射缺失，${text.length} 字里汉字/字母占比过低）`
        : `文本为空（${text.length} 字）`;
      console.log(`[${i + 1}/${targets.length}] ${rec.id} ⚠ ${why} → needs-ocr  ${label}`);
      report.push({ id: rec.id, chars: text.length, state: 'needs-ocr', reason: mojibake ? 'mojibake' : 'empty' });
    } else {
      rec.text = `cache/text/${rec.id}.txt`;
      if (rec.status === 'needs-ocr') rec.status = rec.note ? 'noted' : 'registered';
      ok++;
      console.log(
        `[${i + 1}/${targets.length}] ${rec.id} ✓ ${String(text.length).padStart(7)} 字${pages ? ` / ${pages} 页` : ''} [${kind}]  ${label}`,
      );
      report.push({ id: rec.id, chars: text.length, pages: pages || null, state: 'extracted' });
    }
    rec.updated = new Date().toISOString().slice(0, 10);
  } catch (err) {
    failed++;
    rec.status = 'deferred';
    rec.updated = new Date().toISOString().slice(0, 10);
    console.log(`[${i + 1}/${targets.length}] ${rec.id} ✗ ${err.message}  ${label}`);
    report.push({ id: rec.id, state: 'failed', error: err.message });
  }
}

records.sort((a, b) => a.id.localeCompare(b.id));
await saveCatalog(records);

// 报告按 id 合并，保持它是「每个文件当前状态」而不是「本次运行的日志」
const REPORT = path.join(KB, 'index', 'extract-report.json');
let merged = new Map();
try {
  const prev = JSON.parse(await readFile(REPORT, 'utf8'));
  merged = new Map((prev.report || []).map((r) => [r.id, r]));
} catch {
  /* 首次运行没有旧报告 */
}
for (const r of report) merged.set(r.id, r);
const all = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
await writeFile(
  REPORT,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      ok: all.filter((r) => r.state === 'extracted' || r.state === 'cached').length,
      empty: all.filter((r) => r.state === 'needs-ocr').length,
      failed: all.filter((r) => r.state === 'failed').length,
      report: all,
    },
    null,
    2,
  ),
  'utf8',
);

console.log('\n===== 本次运行 =====');
console.log(`成功 ${ok} / 空文本或乱码(needs-ocr) ${empty} / 失败 ${failed}`);
console.log('===== 全部文件当前状态 =====');
console.log(`已抽到文本 ${all.filter((r) => r.state === 'extracted' || r.state === 'cached').length} / needs-ocr ${all.filter((r) => r.state === 'needs-ocr').length} / 失败 ${all.filter((r) => r.state === 'failed').length}`);
console.log(`缓存目录 cache/text/  报告 index/extract-report.json`);
