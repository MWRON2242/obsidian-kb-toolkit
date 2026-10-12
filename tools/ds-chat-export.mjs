#!/usr/bin/env node
/**
 * ds-chat-export.mjs —— 把 DeepSeek 导出里的会话转成 Markdown
 *
 * 只读 conversations.json（原件永不修改），Markdown 输出到指定目录。
 *
 * 用法：
 *   # 先预览（不写文件）：打印某个会话转换后的样子
 *   node tools/ds-chat-export.mjs <conversations.json> --preview=<会话id或标题片段>
 *   node tools/ds-chat-export.mjs <conversations.json> --preview --index=0 --lines=60
 *
 *   # 正式导出
 *   node tools/ds-chat-export.mjs <conversations.json> --out=<输出目录>
 *   node tools/ds-chat-export.mjs <conversations.json> --out=<目录> --only=<id,id,...>
 *   node tools/ds-chat-export.mjs <conversations.json> --out=<目录> --min-score=6 --report=<分析报告.json>
 *
 * 选项：
 *   --out=<目录>        输出目录（不写文件时必须省略）
 *   --only=<id,id>      只导出指定会话 id（逗号分隔）
 *   --min-score=<n>     配合 --report：只导出相关度 ≥ n 的会话
 *   --report=<文件>     使用 ds-chat-analyze.mjs 生成的 _analysis.json 打分
 *   --no-think          不导出「深度思考」内容（默认导出，折叠在 details 里）
 *   --no-tools          不导出联网搜索/工具调用过程（默认导出，折叠）
 *   --preview[=关键词]  预览模式，不写文件
 *   --index=<n>         预览时指定第 n 个会话（按时间排序）
 *   --lines=<n>         预览时最多打印多少行（默认 80）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const opt = (n, d = null) => {
  const withEq = argv.find((a) => a.startsWith(`${n}=`));
  if (withEq) return withEq.slice(n.length + 1);
  return argv.includes(n) ? true : d;
};

if (!file) {
  console.error('用法见文件头注释。最少需要：node tools/ds-chat-export.mjs <conversations.json> --out=<目录>');
  process.exit(1);
}

const OUT = opt('--out');
const PREVIEW = opt('--preview', null);
const ONLY = (opt('--only', '') || '').split(',').filter(Boolean);
const MIN_SCORE = opt('--min-score') === null ? null : Number(opt('--min-score'));
const REPORT = opt('--report');
const WITH_THINK = !argv.includes('--no-think');
const WITH_TOOLS = !argv.includes('--no-tools');
const PREVIEW_INDEX = Number(opt('--index', 0));
const PREVIEW_LINES = Number(opt('--lines', 80));
const MAX_NAME = 60;

const data = JSON.parse(readFileSync(file, 'utf8'));

/** 相关度打分表（可选） */
let scoreById = new Map();
if (REPORT) {
  const rep = JSON.parse(readFileSync(REPORT, 'utf8'));
  for (const c of rep.conversations || []) scoreById.set(c.id, c);
}

/** 按 root→children 深度优先还原顺序；分叉时全部保留并标注 */
function flatten(conv) {
  const tree = conv.mapping || {};
  const roots = Object.values(tree).filter((n) => n && n.parent === null);
  const out = [];
  const seen = new Set();
  const stack = (roots.length ? roots : Object.values(tree)).slice().reverse().map((n) => ({ node: n, branch: false }));
  while (stack.length) {
    const { node, branch } = stack.pop();
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    if (node.message) out.push({ node, branch });
    const kids = (node.children || []).map((c) => tree[c]).filter(Boolean);
    kids.forEach((k, i) => stack.push({ node: k, branch: branch || i > 0 }));
  }
  return out;
}

const ROLE = {
  REQUEST: { icon: '👤', label: '提问' },
  RESPONSE: { icon: '🤖', label: '回答' },
  THINK: { icon: '🧠', label: '深度思考' },
  SEARCH: { icon: '🔍', label: '联网搜索' },
  TOOL_SEARCH: { icon: '🔍', label: '联网搜索' },
  TOOL_OPEN: { icon: '📄', label: '打开网页' },
  TOOL_FIND: { icon: '🔎', label: '查找' },
  FILE: { icon: '📎', label: '附件' },
};

function renderMessage(conv, entry, out) {
  const { node, branch } = entry;
  for (const fr of node.message.fragments || []) {
    const type = fr.type || 'UNKNOWN';
    // 对话原文里可能出现 [[world:001]] 这类原始标记：转义掉，避免 Obsidian 把它
    // 当成知识库链接（会在图谱里产生一堆悬空节点，也会污染链接补全）
    const content = (fr.content || '').replace(/\[\[/g, '\\[\\[').trim();
    if (!content) continue;
    if (type === 'THINK' && !WITH_THINK) continue;
    if (['SEARCH', 'TOOL_SEARCH', 'TOOL_OPEN', 'TOOL_FIND', 'FILE'].includes(type) && !WITH_TOOLS) continue;

    const meta = ROLE[type] || { icon: '❔', label: type };
    const stamp = (node.message.inserted_at || '').slice(0, 19).replace('T', ' ');
    const model = node.message.model || '';
    const branchTag = branch ? '　`分支`' : '';

    if (type === 'REQUEST' || type === 'RESPONSE') {
      out.push(`## ${meta.icon} ${meta.label}${branchTag}`);
      out.push('');
      out.push(content);
      out.push('');
      out.push(`<sub>${stamp}　${model}</sub>`);
      out.push('');
    } else {
      // 思考链 / 工具调用 / 附件：折叠，避免淹没正文
      out.push(`<details><summary>${meta.icon} ${meta.label}（${content.length} 字）</summary>`);
      out.push('');
      out.push('```text');
      out.push(content.length > 4000 ? content.slice(0, 4000) + '\n…（已截断）' : content);
      out.push('```');
      out.push('');
      out.push('</details>');
      out.push('');
    }
  }
}

function renderConversation(conv) {
  const entries = flatten(conv);
  const msgs = entries.flatMap((e) => (e.node.message.fragments || []).map((f) => ({ ...f, at: e.node.message.inserted_at })));
  const date = (conv.inserted_at || '').slice(0, 10);
  const models = [...new Set(entries.map((e) => e.node.message.model).filter(Boolean))];
  const nUser = msgs.filter((m) => m.type === 'REQUEST').length;
  const nAsst = msgs.filter((m) => m.type === 'RESPONSE').length;
  const chars = msgs.filter((m) => m.type === 'REQUEST' || m.type === 'RESPONSE').reduce((a, m) => a + (m.content || '').length, 0);
  const branched = entries.some((e) => e.branch);
  const score = scoreById.get(conv.id)?.score;

  const head = [
    '---',
    `kb_chat: ${conv.id}`,
    `title: ${JSON.stringify(conv.title || '未命名对话').replace(/^"|"$/g, '')}`,
    `date: ${date}`,
    `updated_at: ${(conv.updated_at || '').slice(0, 19).replace('T', ' ')}`,
    `models: [${models.join(', ')}]`,
    `turns: ${nUser}`,
    `chars: ${chars}`,
    ...(score === undefined ? [] : [`relevance_score: ${score}`]),
    ...(branched ? ['branched: true'] : []),
    'source_export: conversations.json',
    '---',
    '',
    `# ${conv.title || '未命名对话'}`,
    '',
    `> 来自 DeepSeek 官方导出　·　${date}　·　${nUser} 轮问答　·　正文约 ${chars} 字　·　模型 ${models.join(' / ') || '—'}`,
    '> 本文件由 `tools/ds-chat-export.mjs` 生成，**原件（conversations.json）未被修改**。',
    '',
  ];
  const body = [];
  for (const e of entries) renderMessage(conv, e, body);
  return { markdown: [...head, ...body].join('\n'), date, chars, nUser, nAsst };
}

function safeName(s) {
  return (s || '未命名对话')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME)
    .replace(/[. ]+$/, '');
}

/* ---------- 预览模式 ---------- */
if (!OUT) {
  const list = data.slice().sort((a, b) => (a.inserted_at || '').localeCompare(b.inserted_at || ''));
  let target;
  if (typeof PREVIEW === 'string' && PREVIEW.length) {
    target = data.find((c) => (c.title || '').includes(PREVIEW) || c.id === PREVIEW);
  } else {
    target = list[PREVIEW_INDEX];
  }
  if (!target) {
    console.error('找不到要预览的会话。');
    process.exit(1);
  }
  const { markdown } = renderConversation(target);
  const lines = markdown.split('\n');
  console.log(`【预览】${target.title}　（共 ${lines.length} 行，显示前 ${PREVIEW_LINES} 行，未写入任何文件）\n`);
  console.log(lines.slice(0, PREVIEW_LINES).join('\n'));
  if (lines.length > PREVIEW_LINES) console.log(`\n…（其余 ${lines.length - PREVIEW_LINES} 行省略）`);
  process.exit(0);
}

/* ---------- 正式导出 ---------- */
let targets = data;
if (ONLY.length) targets = targets.filter((c) => ONLY.includes(c.id));
if (MIN_SCORE !== null) {
  if (!scoreById.size) {
    console.error('--min-score 需要配合 --report=<_analysis.json>');
    process.exit(1);
  }
  targets = targets.filter((c) => (scoreById.get(c.id)?.score ?? -999) >= MIN_SCORE);
}

mkdirSync(OUT, { recursive: true });
const manifest = [];
const usedNames = new Set();

for (const conv of targets) {
  const { markdown, date, chars, nUser } = renderConversation(conv);
  let base = `${date}-${safeName(conv.title)}`;
  let name = `${base}.md`;
  let n = 2;
  while (usedNames.has(name.toLowerCase())) name = `${base} (${n++}).md`;
  usedNames.add(name.toLowerCase());
  writeFileSync(path.join(OUT, name), markdown, 'utf8');
  manifest.push({ file: name, id: conv.id, title: conv.title, date, turns: nUser, chars, score: scoreById.get(conv.id)?.score ?? null });
}

// 清单按 id 合并写入：增量导出（--only）不会抹掉之前导出的记录
const MANIFEST = path.join(OUT, '_manifest.json');
let merged = new Map();
try {
  const prev = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  for (const f of prev.files || []) merged.set(f.id, f);
} catch {
  /* 首次导出没有旧清单 */
}
for (const m of manifest) merged.set(m.id, m);
const all = [...merged.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
writeFileSync(
  MANIFEST,
  JSON.stringify({ exportedAt: new Date().toISOString(), source: file, count: all.length, files: all }, null, 2),
  'utf8',
);

console.log(`已导出 ${manifest.length} 个会话 → ${OUT}`);
console.log(`合计正文约 ${(manifest.reduce((a, m) => a + m.chars, 0) / 10000).toFixed(1)} 万字`);
console.log(`清单：${path.join(OUT, '_manifest.json')}`);
