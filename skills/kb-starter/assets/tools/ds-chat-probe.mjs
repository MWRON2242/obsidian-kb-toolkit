#!/usr/bin/env node
/**
 * ds-chat-probe.mjs —— 探明 DeepSeek 官方导出 conversations.json 的数据结构
 *
 * 只读、只打印结构（字段名与类型），不打印正文内容，不写任何数据文件。
 * 用法：node tools/ds-chat-probe.mjs <conversations.json 路径>
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('用法: node tools/ds-chat-probe.mjs <conversations.json>');
  process.exit(1);
}

const raw = readFileSync(file, 'utf8');
console.log(`文件大小：${(raw.length / 1024 / 1024).toFixed(2)} MB（UTF-8 字符数 ${raw.length.toLocaleString()}）`);
const data = JSON.parse(raw);

const typeOf = (v) => (Array.isArray(v) ? `数组[${v.length}]` : v === null ? 'null' : typeof v);

function shape(v, depth, maxDepth, indent = '  ') {
  if (depth > maxDepth) return;
  if (Array.isArray(v)) {
    if (!v.length) return;
    console.log(`${indent}└ 样例元素：`);
    shape(v[0], depth + 1, maxDepth, indent + '  ');
    return;
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      const t = typeOf(val);
      if (val && typeof val === 'object') {
        console.log(`${indent}${k}: ${t}`);
        shape(val, depth + 1, maxDepth, indent + '  ');
      } else {
        const preview = typeof val === 'string' ? `　样例="${val.slice(0, 40).replace(/\n/g, '⏎')}${val.length > 40 ? '…' : ''}"（长度 ${val.length}）` : `　样例=${JSON.stringify(val)}`;
        console.log(`${indent}${k}: ${t}${preview}`);
      }
    }
  }
}

console.log(`\n顶层类型：${typeOf(data)}`);
if (!Array.isArray(data) && data && typeof data === 'object') {
  console.log(`顶层字段：${Object.keys(data).join(', ')}`);
}

// 找到「会话数组」在哪
let list = null;
let listPath = '';
if (Array.isArray(data)) {
  list = data;
  listPath = '(顶层)';
} else {
  for (const [k, v] of Object.entries(data || {})) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      list = v;
      listPath = k;
      break;
    }
  }
}
if (!list) {
  console.log('\n没有找到会话数组，请人工查看。');
  process.exit(0);
}

console.log(`\n会话数组位置：${listPath}　共 ${list.length} 个会话`);
console.log(`\n===== 单个会话的结构（第 1 个）=====`);
shape(list[0], 1, 4);

// 找出消息数组
const conv = list[0];
let msgs = null;
let msgsKey = '';
for (const [k, v] of Object.entries(conv)) {
  if (Array.isArray(v) && v.length && typeof v[0] === 'object' && !Array.isArray(v[0])) {
    msgs = v;
    msgsKey = k;
    break;
  }
}
if (msgs) {
  console.log(`\n===== 消息结构（${msgsKey}[0]，共 ${msgs.length} 条）=====`);
  shape(msgs[0], 1, 4);
} else {
  console.log('\n（该会话里没找到明显的消息数组，这是 mapping 树结构，下面按树展开）');
}

/* ---------- 深度样例：mapping 树前若干条消息的 fragments ---------- */
const tree = conv.mapping;
if (tree && typeof tree === 'object') {
  console.log('\n===== mapping 树深度样例（按 parent→child 顺序取前 4 条）=====');
  let cur = Object.values(tree).find((n) => n && n.parent === null);
  const seen = new Set();
  for (let i = 0; i < 4 && cur; i++) {
    seen.add(cur.id);
    const m = cur.message;
    console.log(`\n[节点 ${cur.id}] parent=${cur.parent} children=${JSON.stringify(cur.children)}`);
    if (!m) {
      console.log('  message = null（根节点）');
    } else {
      console.log(`  message 字段：${Object.keys(m).join(', ')}`);
      for (const k of Object.keys(m)) {
        if (k === 'fragments') continue;
        const v = m[k];
        const s = typeof v === 'string' ? `"${v.slice(0, 50)}"` : JSON.stringify(v);
        console.log(`    ${k} = ${s}`);
      }
      const frs = m.fragments || [];
      console.log(`  fragments：${frs.length} 个`);
      frs.forEach((fr, j) => {
        console.log(`    [${j}] 字段：${Object.keys(fr).join(', ')}`);
        for (const [k, v] of Object.entries(fr)) {
          if (k === 'content' && typeof v === 'string') {
            console.log(`        ${k}：长度 ${v.length}　开头="${v.slice(0, 70).replace(/\n/g, '⏎')}…"`);
          } else {
            console.log(`        ${k} = ${typeof v === 'string' ? `"${v.slice(0, 40)}"` : JSON.stringify(v)}`);
          }
        }
      });
    }
    cur = (cur.children || []).map((c) => tree[c]).find((n) => n && !seen.has(n.id));
  }
}
