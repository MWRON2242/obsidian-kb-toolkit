#!/usr/bin/env node
/**
 * search.mjs —— 知识库本地检索
 *
 * 检索四个层次（全部本地完成，不联网、不外发）：
 *   1. catalog  —— 元数据（标题、路径、标签、状态）
 *   2. notes/   —— 摘要卡
 *   3. 正文层   —— cache/text/<id>.txt（文档抽取）与 chats/*.md（对话原文）
 *   4. digests/ —— 成品与改写（按 <id>- 前缀关联）
 *
 * 用法：
 *   node tools/search.mjs 延迟满足
 *   node tools/search.mjs 作文 分析 --tag=作文 --limit=10
 *   node tools/search.mjs 红楼梦 --type=pdf --status=noted
 *   node tools/search.mjs 审题 --layer=chat          # 只搜对话原文层
 *   node tools/search.mjs 素材 --json               # 输出 JSON，便于 Agent 解析
 *   node tools/search.mjs --tag=班务 --list          # 只按标签列条目
 *
 * 语义：多个关键词默认 AND（同一文件里都要出现）；用 | 连接表示 OR，例如 `作文|范文`。
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const CATALOG = path.join(KB, 'index', 'catalog.jsonl');
const NOTES = path.join(KB, 'notes');
const TEXT = path.join(KB, 'cache', 'text');
const CHATS = path.join(KB, 'chats');
const DIGESTS = path.join(KB, 'digests');
const EXTERNAL = path.join(KB, 'external');
const MATERIALS = path.join(KB, 'materials');

const argv = process.argv.slice(2);
const opt = (n) => {
  const hit = argv.find((a) => a.startsWith(`${n}=`));
  return hit ? hit.slice(n.length + 1) : null;
};
const flag = (n) => argv.includes(n);

const LIMIT = Number(opt('--limit') || 15);
const CONTEXT = Number(opt('--context') || 1);
const AS_JSON = flag('--json');
const LIST_ONLY = flag('--list');
const TAG = opt('--tag');
const TYPE = opt('--type');
const STATUS = opt('--status');
const LAYER = opt('--layer'); // meta | note | text | chat | digest

const terms = argv.filter((a) => !a.startsWith('--')).map((t) => t.split('|'));
if (!terms.length && !TAG) {
  console.log('用法: node tools/search.mjs <关键词...> [--tag=] [--type=] [--status=] [--layer=] [--limit=] [--context=] [--json] [--list]');
  process.exit(1);
}

function matched(text) {
  const lower = text.toLowerCase();
  return terms.every((group) => group.some((t) => lower.includes(t.toLowerCase())));
}

function snippet(lines, context) {
  const hits = [];
  for (let i = 0; i < lines.length && hits.length < 3; i++) {
    const l = lines[i].toLowerCase();
    if (terms.some((g) => g.some((t) => l.includes(t.toLowerCase())))) {
      const from = Math.max(0, i - context);
      const to = Math.min(lines.length, i + context + 1);
      hits.push({ line: i + 1, text: lines.slice(from, to).map((x) => x.trim()).filter(Boolean).join(' / ') });
    }
  }
  return hits;
}

const records = (await readFile(CATALOG, 'utf8'))
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

async function readDirFiles(dir, ext) {
  if (!existsSync(dir)) return [];
  const names = await readdir(dir);
  const out = [];
  for (const n of names) {
    if (ext && !n.endsWith(ext)) continue;
    out.push({ name: n, text: await readFile(path.join(dir, n), 'utf8') });
  }
  return out;
}

const noteFiles = await readDirFiles(NOTES, '.md');
const textFiles = await readDirFiles(TEXT, '.txt');
const chatFiles = await readDirFiles(CHATS, '.md');
const digestFiles = await readDirFiles(DIGESTS, '.md');

/** 递归收集 external/ 下的 md（它按来源分目录） */
async function readTree(dir, ext, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await readTree(full, ext, out);
    else if (!ext || e.name.endsWith(ext)) out.push({ name: e.name, rel: path.relative(KB, full).split(path.sep).join('/'), text: await readFile(full, 'utf8') });
  }
  return out;
}
const externalFiles = await readTree(EXTERNAL, '.md');
const materialFiles = (await readTree(MATERIALS, '.md')).filter((f) => !f.name.startsWith('_') && f.name !== '素材库总表.md');

const noteById = new Map(noteFiles.map((f) => [f.name.split('-').slice(0, 2).join('-'), f]));
const textById = new Map(textFiles.map((f) => [f.name.replace(/\.txt$/, ''), f]));
// 对话原文层与成品层按「原件路径 / 文件名前缀」关联回 id
const idByBase = new Map(records.map((r) => [path.basename(r.source).toLowerCase(), r.id]));
const chatById = new Map();
for (const f of chatFiles) {
  const id = idByBase.get(f.name.toLowerCase());
  if (id) chatById.set(id, f);
}
const digestById = new Map();
for (const f of digestFiles) {
  const m = /^(kb-\d+)/.exec(f.name);
  if (!m) continue;
  if (!digestById.has(m[1])) digestById.set(m[1], []);
  digestById.get(m[1]).push(f);
}

const want = (layer) => !LAYER || LAYER === layer;
const results = [];

for (const rec of records) {
  if (TAG && !(rec.tags || []).includes(TAG)) continue;
  if (TYPE && rec.source_type !== TYPE) continue;
  if (STATUS && rec.status !== STATUS) continue;

  const hay = [rec.id, rec.title, rec.source, rec.label, (rec.tags || []).join(' '), rec.note || ''].join('\n');
  const metaHit = !LIST_ONLY && terms.length && want('meta') ? matched(hay) : false;

  const note = noteById.get(rec.id);
  const noteHits = !LIST_ONLY && note && terms.length && want('note') && matched(note.text) ? snippet(note.text.split('\n'), CONTEXT) : [];
  const txt = textById.get(rec.id);
  const txtHits = !LIST_ONLY && txt && terms.length && want('text') && matched(txt.text) ? snippet(txt.text.split('\n'), CONTEXT) : [];
  const chat = chatById.get(rec.id);
  const chatHits = !LIST_ONLY && chat && terms.length && want('chat') && matched(chat.text) ? snippet(chat.text.split('\n'), CONTEXT) : [];
  const digs = (digestById.get(rec.id) || []).filter((d) => terms.length && want('digest') && matched(d.text));
  const digestHits = !LIST_ONLY ? digs.flatMap((d) => snippet(d.text.split('\n'), CONTEXT).map((h) => ({ ...h, file: `digests/${d.name}` }))) : [];

  if (LIST_ONLY ? true : metaHit || noteHits.length || txtHits.length || chatHits.length || digestHits.length) {
    results.push({
      id: rec.id,
      title: rec.title,
      status: rec.status,
      tags: rec.tags || [],
      type: rec.source_type,
      source: rec.source,
      note: rec.note,
      chars: (txt?.text.length || 0) + (chat?.text.length || 0),
      where: [
        metaHit && 'meta',
        noteHits.length && 'note',
        txtHits.length && 'text',
        chatHits.length && 'chat',
        digestHits.length && 'digest',
      ].filter(Boolean),
      noteHits,
      txtHits,
      chatHits,
      digestHits,
    });
  }
}

results.sort((a, b) => {
  const score = (r) =>
    (r.chatHits.length ? 4 : 0) + (r.txtHits.length ? 3 : 0) + (r.noteHits.length ? 2 : 0) + (r.digestHits.length ? 2 : 0) + (r.where.includes('meta') ? 1 : 0);
  return score(b) - score(a) || a.id.localeCompare(b.id);
});

const shown = results.slice(0, LIMIT);

/* ---------- 外部镜像层（external/，不属于 catalog，单独列出） ---------- */
const externalHits = [];
if (!LIST_ONLY && terms.length && want('external')) {
  for (const f of externalFiles) {
    if (!matched(f.text)) continue;
    externalHits.push({ rel: f.rel, hits: snippet(f.text.split('\n'), CONTEXT) });
  }
}

/* ---------- 素材条目层（materials/，不属于 catalog，单独列出） ---------- */
const materialHits = [];
if (!LIST_ONLY && terms.length && want('material')) {
  for (const f of materialFiles) {
    if (!matched(f.text)) continue;
    materialHits.push({ rel: f.rel, hits: snippet(f.text.split('\n'), CONTEXT) });
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ query: terms, layers: LAYER || 'all', total: results.length, shown: shown.length, items: shown, external: externalHits }, null, 2));
} else {
  console.log(`命中 ${results.length} 条${results.length > shown.length ? `（显示前 ${shown.length} 条）` : ''}\n`);
  for (const r of shown) {
    console.log(`${r.id}  ${r.title}   [${r.status}] ${r.type}${r.tags.length ? '  #' + r.tags.join(' #') : ''}`);
    console.log(`   原件: ${r.source}`);
    if (r.note) console.log(`   卡片: ${r.note}${r.chars ? `   可搜正文: ${r.chars} 字` : ''}`);
    const all = [
      ...r.noteHits.map((x) => ({ ...x, src: '卡片' })),
      ...r.txtHits.map((x) => ({ ...x, src: '抽取正文' })),
      ...r.chatHits.map((x) => ({ ...x, src: '对话原文' })),
      ...r.digestHits.map((x) => ({ ...x, src: x.file })),
    ];
    for (const h of all) console.log(`   [${h.src}:${h.line}] ${h.text.slice(0, 200)}`);
    console.log('');
  }
  if (!results.length) console.log('知识库中没有匹配内容。可以试试更短的关键词，或先运行 scan.mjs 登记新文件。');

  if (LAYER === 'material' || materialHits.length) {
    console.log(`\n----- 素材条目（materials/，逐字搬运自对话原文）${materialHits.length} 条 -----`);
    for (const e of materialHits.slice(0, LIMIT)) {
      console.log(`   ${e.rel}`);
      for (const h of e.hits) console.log(`     [:${h.line}] ${h.text.slice(0, 180)}`);
    }
    if (materialHits.length > LIMIT) console.log(`   …另有 ${materialHits.length - LIMIT} 条`);
  }

  if (LAYER === 'external' || externalHits.length) {
    console.log(`\n----- 外部镜像笔记（external/，来自主 Obsidian 库）${externalHits.length} 条 -----`);
    for (const e of externalHits.slice(0, LIMIT)) {
      console.log(`   ${e.rel}`);
      for (const h of e.hits) console.log(`     [:${h.line}] ${h.text.slice(0, 180)}`);
    }
    if (externalHits.length > LIMIT) console.log(`   …另有 ${externalHits.length - LIMIT} 条`);
  }
}
