#!/usr/bin/env node
/**
 * ds-chat-batches.mjs —— 把 chats/ 里的对话原文按字数均衡分成若干批，供子代理并行建卡
 *
 * 只读 catalog 与 chats/_manifest.json，不写任何文件。
 *
 * 用法：
 *   node tools/ds-chat-batches.mjs                 # 默认 10 批
 *   node tools/ds-chat-batches.mjs --batches=8
 *   node tools/ds-chat-batches.mjs --from=1 --to=5 # 只看第 1~5 批
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.find((a) => a.startsWith(`${n}=`)) || `${n}=${d}`).split('=')[1];
const N = Number(arg('--batches', 10));
const FROM = Number(arg('--from', 1));
const TO = Number(arg('--to', N));

const manifestPath = path.join(KB, 'chats', '_manifest.json');
const records = readFileSync(path.join(KB, 'index', 'catalog.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// 以 catalog 为准（chats/ 下的登记记录），不依赖 _manifest.json ——
// 增量导出会覆盖 manifest，但 catalog 是累积的。
const onlyMissing = !argv.includes('--all');
const chatRecords = records.filter((r) => r.root === 'chats' && (!onlyMissing || !r.note));
const items = [];
for (const r of chatRecords) {
  if (!existsSync(r.source)) continue;
  const chars = readFileSync(r.source, 'utf8').length;
  const date = (r.title.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
  items.push({ id: r.id, file: path.basename(r.source), title: r.title, date, chars });
}
if (!items.length) {
  console.log('没有需要处理的对话记录（加 --all 可对全部已建卡的会话重新分批）。');
  process.exit(0);
}
items.sort((a, b) => b.chars - a.chars);

// 贪心均衡分配：每次把当前最大的放进当前总字数最小的一批
const batches = Array.from({ length: N }, () => ({ items: [], chars: 0 }));
for (const it of items) {
  let min = 0;
  for (let i = 1; i < N; i++) if (batches[i].chars < batches[min].chars) min = i;
  batches[min].items.push(it);
  batches[min].chars += it.chars;
}

for (let i = 0; i < N; i++) {
  if (i + 1 < FROM || i + 1 > TO) continue;
  const b = batches[i];
  console.log(`\n===== 第 ${i + 1} 批：${b.items.length} 个会话，正文 ${(b.chars / 10000).toFixed(1)} 万字 =====`);
  for (const it of b.items.sort((a, b2) => (a.date || '').localeCompare(b2.date || ''))) {
    console.log(`${it.id} | ${(it.chars / 1000).toFixed(1)}k字 | ${it.file}`);
  }
}
console.log(`\n合计 ${items.length} 个会话，${(items.reduce((a, x) => a + x.chars, 0) / 10000).toFixed(1)} 万字，分 ${N} 批`);
