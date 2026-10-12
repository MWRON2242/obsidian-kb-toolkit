#!/usr/bin/env node
/**
 * ds-chat-analyze.mjs —— 分析 DeepSeek 官方导出的 conversations.json
 *
 * 只读导出文件，输出统计报告与「语文作文相关」候选清单（不写正文、不改原件）。
 *
 * 数据结构（已实测确认）：
 *   [ { id, title, inserted_at, updated_at,
 *       mapping: { "root": {id,parent:null,children:[...],message:null},
 *                  "1":    {id,parent:"root",children:["2"],
 *                           message:{ model, inserted_at,
 *                                     fragments:[{ type:"REQUEST"|"RESPONSE", content }] }} } } ]
 *
 * 用法：
 *   node tools/ds-chat-analyze.mjs <conversations.json> [--out=<报告路径>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const outArg = (argv.find((a) => a.startsWith('--out=')) || '').split('=')[1];
if (!file) {
  console.error('用法: node tools/ds-chat-analyze.mjs <conversations.json> [--out=报告.json]');
  process.exit(1);
}

/* ---------- 关键词表 ---------- */
// A 类：语文/作文的直接词汇（标题命中权重更高）
const KEY_A = [
  '作文', '议论文', '记叙文', '说明文', '散文', '材料作文', '命题作文', '半命题', '话题作文',
  '审题', '立意', '范文', '作文题', '自拟题目', '自拟标题', '论点', '论据', '论证', '修辞',
  '排比', '比喻论证', '读后感', '观后感', '演讲稿', '语文', '文言文', '古诗文', '高考作文',
  '语文老师', '语文课', '作文批改', '作文点评', '作文素材', '写作', '文采', '开头结尾',
];
// B 类：作文题面特征句（出现即强烈提示这是作文任务）
const KEY_B = [
  '请写一篇文章', '写一篇文章', '不少于800字', '不少于 800 字', '不少于800 字',
  '谈谈你的认识与思考', '谈谈你的认识和思考', '文体不限', '诗歌除外', '自拟标题',
  '根据以下材料', '阅读下面的材料', '结合材料', '立意自定', '题目自拟',
];
// C 类：负向词（出现说明大概率是技术/工程类对话）
const KEY_C = ['代码', '函数', '报错', '编译', '单片机', '电路', 'PCB', '寄存器', 'STM32', 'Python', 'Keil'];

const data = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(data)) {
  console.error('顶层不是数组，结构可能已变化。');
  process.exit(1);
}

/** 按 root→children 深度优先还原消息顺序 */
function flatten(conv) {
  const tree = conv.mapping || {};
  const out = [];
  const roots = Object.values(tree).filter((n) => n && n.parent === null);
  const seen = new Set();
  const stack = roots.length ? roots.slice().reverse() : Object.values(tree).slice().reverse();
  while (stack.length) {
    const node = stack.pop();
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    if (node.message) out.push(node);
    const kids = (node.children || []).map((c) => tree[c]).filter(Boolean);
    for (const k of kids.reverse()) stack.push(k);
  }
  return out;
}

const stats = {
  conversations: data.length,
  messages: 0,
  requestChars: 0,
  responseChars: 0,
  models: {},
  fragTypes: {},
  branchedNodes: 0,
  minDate: null,
  maxDate: null,
  emptyConvs: 0,
};

const convs = [];
for (const conv of data) {
  const nodes = flatten(conv);
  const msgs = [];
  for (const n of nodes) {
    for (const fr of n.message.fragments || []) {
      const type = fr.type || 'UNKNOWN';
      stats.fragTypes[type] = (stats.fragTypes[type] || 0) + 1;
      if (type === 'REQUEST') stats.requestChars += (fr.content || '').length;
      if (type === 'RESPONSE') stats.responseChars += (fr.content || '').length;
      msgs.push({ role: type === 'REQUEST' ? 'user' : type === 'RESPONSE' ? 'assistant' : type.toLowerCase(), content: fr.content || '', model: n.message.model || '', at: n.message.inserted_at || '' });
    }
    const m = n.message.model;
    if (m) stats.models[m] = (stats.models[m] || 0) + 1;
    if ((n.children || []).length > 1) stats.branchedNodes++;
  }
  stats.messages += msgs.length;
  if (!msgs.length) stats.emptyConvs++;

  const dates = [conv.inserted_at, conv.updated_at].filter(Boolean).sort();
  if (dates.length) {
    const a = dates[0];
    const b = dates[dates.length - 1];
    if (!stats.minDate || a < stats.minDate) stats.minDate = a;
    if (!stats.maxDate || b > stats.maxDate) stats.maxDate = b;
  }

  const text = msgs.map((m) => m.content).join('\n');
  const title = conv.title || '';
  const hitA_title = KEY_A.filter((k) => title.includes(k));
  const hitA_body = KEY_A.filter((k) => text.includes(k));
  const hitB = KEY_B.filter((k) => text.includes(k));
  const hitC = KEY_C.filter((k) => text.includes(k));
  const titleChars = text.length;
  const score =
    hitA_title.length * 6 +
    Math.min(hitA_body.length, 6) * 1 +
    Math.min(hitB.length, 4) * 3 -
    Math.min(hitC.length, 6) * 1;

  convs.push({
    id: conv.id,
    title,
    inserted_at: conv.inserted_at,
    updated_at: conv.updated_at,
    messages: msgs.length,
    chars: titleChars,
    userChars: msgs.filter((m) => m.role === 'user').reduce((a, m) => a + m.content.length, 0),
    score,
    hitA_title,
    hitA_body: hitA_body.slice(0, 8),
    hitB,
    hitC: hitC.slice(0, 6),
  });
}

/* ---------- 报告 ---------- */
const fmtDate = (s) => (s ? s.slice(0, 10) : '—');
console.log('===== 导出数据总览 =====');
console.log(`会话数        : ${stats.conversations}`);
console.log(`消息条数      : ${stats.messages.toLocaleString()}（fragment 类型：${Object.entries(stats.fragTypes).map(([k, v]) => `${k} ${v}`).join('、')}）`);
console.log(`提问总字数    : ${stats.requestChars.toLocaleString()}`);
console.log(`回答总字数    : ${stats.responseChars.toLocaleString()}（合计约 ${((stats.requestChars + stats.responseChars) / 10000).toFixed(1)} 万字）`);
console.log(`模型分布      : ${Object.entries(stats.models).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('　')}`);
console.log(`时间范围      : ${fmtDate(stats.minDate)} ~ ${fmtDate(stats.maxDate)}`);
console.log(`空会话        : ${stats.emptyConvs}　分叉节点：${stats.branchedNodes}`);

const sorted = convs.slice().sort((a, b) => b.score - a.score || b.chars - a.chars);
const tiers = [
  ['强相关（分数 ≥ 12）', sorted.filter((c) => c.score >= 12)],
  ['较相关（6 ≤ 分数 < 12）', sorted.filter((c) => c.score >= 6 && c.score < 12)],
  ['弱相关（0 < 分数 < 6）', sorted.filter((c) => c.score > 0 && c.score < 6)],
  ['不相关（分数 ≤ 0）', sorted.filter((c) => c.score <= 0)],
];
console.log('\n===== 语文作文相关度分层 =====');
for (const [label, list] of tiers) {
  console.log(`${label}：${list.length} 个会话，合计 ${(list.reduce((a, c) => a + c.chars, 0) / 10000).toFixed(1)} 万字`);
}

console.log('\n===== 强相关 + 较相关 明细（前 60）=====');
for (const c of [...tiers[0][1], ...tiers[1][1]].slice(0, 60)) {
  const kw = [...new Set([...c.hitA_title.map((k) => k + '(标题)'), ...c.hitA_body, ...c.hitB])].slice(0, 6).join('、');
  const neg = c.hitC.length ? `　⚠技术词：${c.hitC.join('、')}` : '';
  console.log(`[${String(c.score).padStart(3)}] ${fmtDate(c.inserted_at)}  ${String(c.messages).padStart(3)}条 ${String(c.chars).padStart(6)}字  ${c.title}`);
  console.log(`      命中：${kw}${neg}`);
}

const reportPath = outArg || path.join(path.dirname(file), '_analysis.json');
writeFileSync(
  reportPath,
  JSON.stringify(
    {
      source: file,
      analyzedAt: new Date().toISOString(),
      stats,
      tiers: Object.fromEntries(tiers.map(([label, list]) => [label, list.length])),
      conversations: sorted,
    },
    null,
    2,
  ),
  'utf8',
);
console.log(`\n完整分析报告：${reportPath}`);
