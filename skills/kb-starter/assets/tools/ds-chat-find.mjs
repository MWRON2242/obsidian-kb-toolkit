#!/usr/bin/env node
/**
 * ds-chat-find.mjs —— 在官方对话导出里按「学科」检索会话
 *
 * 用途：之前只导入了 82 个作文相关会话；这个工具用来找出其它学科（数学/物理/化学/英语…）
 * 的会话，并给出可直接喂给 ds-chat-export.mjs --only= 的 id 清单。
 *
 * 只读 conversations.json，不写任何数据文件（--out 除外）。
 *
 * 用法：
 *   node tools/ds-chat-find.mjs <conversations.json> --profile=math
 *   node tools/ds-chat-find.mjs <conversations.json> --profile=math --min-score=6
 *   node tools/ds-chat-find.mjs <conversations.json> --profile=math --out=sel.txt
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const opt = (n, d = '') => (argv.find((a) => a.startsWith(`${n}=`)) || `${n}=${d}`).split('=')[1];
const PROFILE = opt('--profile', 'math');
const MIN = Number(opt('--min-score', 3));
const OUT = opt('--out');
/** 按标题片段排除误召（如把"物理竞赛"排除出数学档） */
const EXCLUDE_TITLE = opt('--exclude-title')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (!file) {
  console.error('用法: node tools/ds-chat-find.mjs <conversations.json> --profile=math [--min-score=3] [--out=ids.txt]');
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(path.join(import.meta.dirname, 'topic-profiles.json'), 'utf8'));
const prof = cfg.profiles[PROFILE];
if (!prof) {
  console.error(`没有这个学科档案：${PROFILE}（可选：${Object.keys(cfg.profiles).join(', ')}）`);
  process.exit(1);
}

// 已导入过的会话（chats/ 里每个文件都记着 kb_chat: <uuid>），默认排除，避免重复导入
const alreadyImported = new Set();
const skipDir = opt('--exclude-dir', 'chats');
const absSkip = path.resolve(import.meta.dirname, '..', skipDir);
if (existsSync(absSkip)) {
  for (const f of readdirSync(absSkip)) {
    if (!f.endsWith('.md')) continue;
    const m = /^kb_chat:\s*(\S+)/m.exec(readFileSync(path.join(absSkip, f), 'utf8'));
    if (m) alreadyImported.add(m[1]);
  }
}

const data = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(data)) {
  console.error('顶层不是数组，导出结构可能变了。');
  process.exit(1);
}

/** root→children 深度优先还原该会话的全文 */
function flatten(conv) {
  const tree = conv.mapping || {};
  const out = [];
  const seen = new Set();
  const roots = Object.values(tree).filter((n) => n && n.parent === null);
  const stack = (roots.length ? roots : Object.values(tree)).slice().reverse();
  while (stack.length) {
    const node = stack.pop();
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    if (node.message) for (const fr of node.message.fragments || []) out.push({ type: fr.type, content: fr.content || '' });
    for (const c of (node.children || []).map((x) => tree[x]).filter(Boolean).reverse()) stack.push(c);
  }
  return out;
}

const hits = [];
const allConvs = [];
for (const conv of data) {
  const frags = flatten(conv);
  const q = frags.filter((f) => f.type === 'REQUEST').map((f) => f.content).join('\n');
  const a = frags.filter((f) => f.type === 'RESPONSE').map((f) => f.content).join('\n');
  const all = `${q}\n${a}`;
  const title = conv.title || '';
  const kw = prof.keywords.filter((k) => all.includes(k));
  const kwTitle = prof.keywords.filter((k) => title.includes(k));
  const qm = (prof.questionMarkers || []).filter((k) => q.includes(k) || title.includes(k));
  const neg = (prof.negative || []).filter((k) => title.includes(k) || q.includes(k));
  // 学科记号密度：真正的数学会话里 LaTeX/符号会大量出现，而"顺带提到数学"的会话不会
  const notationHits = (prof.notation || []).reduce((n, p) => n + (all.match(new RegExp(p, 'g')) || []).length, 0);
  const score =
    kwTitle.length * 8 +
    Math.min(kw.length, 8) * 2 +
    Math.min(qm.length, 3) * 2 +
    Math.min(notationHits, 12) -
    Math.min(neg.length, 4) * 3;
  const strongTitle = (prof.strongTitle || []).some((k) => title.includes(k));
  const notationGate = prof.notationGate ?? 15;
  // 双重门控：标题里有强学科词，或正文记号密度够高；两条都不满足就丢掉（避免"顺带提到数学"的会话混入）
  const qualifies = strongTitle || notationHits >= notationGate;
  const excluded = EXCLUDE_TITLE.some((k) => title.includes(k));
  if (score >= MIN && qualifies && !excluded && !alreadyImported.has(conv.id)) {
    hits.push({ id: conv.id, title, date: (conv.inserted_at || '').slice(0, 10), score, kw, kwTitle, qm, neg, chars: a.length, notationHits, strongTitle, already: alreadyImported.has(conv.id) });
  }
  // 反向探测用：不管关键词，只记记号密度（找"纯单词表/纯公式"这类关键词抓不到的会话）
  allConvs.push({ id: conv.id, title, date: (conv.inserted_at || '').slice(0, 10), notationHits, chars: a.length, already: alreadyImported.has(conv.id) });
}

hits.sort((a, b) => b.score - a.score || b.chars - a.chars);

// --probe-notation：不看关键词，只按记号密度排序，用来发现漏召（如纯单词表、纯公式会话）
if (argv.includes('--probe-notation')) {
  const top = allConvs.filter((x) => !x.already).sort((a, b) => b.notationHits - a.notationHits).slice(0, 40);
  console.log(`=== 记号密度反向探测（${prof.label}）——未导入会话按记号数排序 Top 40 ===`);
  for (const h of top) console.log(`[记号 ${String(h.notationHits).padStart(4)}] ${h.date}  ${String(h.chars).padStart(6)}字  ${h.title}`);
  console.log(`\n提示：记号高但没被关键词命中的，往往就是"纯数据/纯列表"型会话。`);
  process.exit(0);
}
console.log(`学科档案：${prof.label}（${PROFILE}）　阈值 ≥${MIN}　门控：标题强学科词 或 记号≥${prof.notationGate ?? 15}`);
console.log(`已排除已导入会话 ${alreadyImported.size} 个`);
console.log(`命中会话 ${hits.length} 个，回答合计约 ${(hits.reduce((a, h) => a + h.chars, 0) / 10000).toFixed(1)} 万字\n`);
for (const h of hits) {
  console.log(`[${String(h.score).padStart(3)}] ${h.date}  ${String(h.chars).padStart(6)}字  记号${String(h.notationHits).padStart(4)}  ${h.title}`);
  console.log(`      命中：${[...h.kwTitle.map((k) => k + '(标题)'), ...h.kw].slice(0, 8).join('、')}${h.neg.length ? `　⚠负向：${h.neg.join('、')}` : ''}`);
}
if (OUT) {
  writeFileSync(OUT, hits.map((h) => h.id).join(','), 'utf8');
  console.log(`\nid 清单已写入 ${OUT}（${hits.length} 个，可直接用于 ds-chat-export.mjs --only=<内容>）`);
}
