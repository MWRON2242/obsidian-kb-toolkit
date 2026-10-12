#!/usr/bin/env node
/**
 * add-source-links.mjs —— 给「对话原文型」摘要卡加一行正文级原文链接
 *
 * 解决的问题：卡片 front matter 里的 `source` 是纯文本路径（在 Obsidian 属性面板里
 * 未必可点，复制到浏览器看体验也差）。这里改成 Obsidian 内部链接（wikilink），
 * 点一下就在应用内打开完整对话。
 *
 * 只处理 root === 'chats' 的记录（即由对话导出生成的卡）；文档型卡片的 source 是
 * 磁盘上的 PDF/docx 绝对路径，不在库内，无法用 wikilink。
 *
 * 幂等：已含「完整原文：」的卡片会跳过。
 *
 * 用法：
 *   node tools/add-source-links.mjs --check
 *   node tools/add-source-links.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const CHECK = process.argv.includes('--check');

const records = readFileSync(path.join(KB, 'index', 'catalog.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const MARK = '完整原文：';
let changed = 0;
let skipped = 0;
const done = [];

for (const r of records) {
  if (r.root !== 'chats' || !r.note) continue;
  const cardPath = path.join(KB, r.note);
  if (!existsSync(cardPath)) continue;

  const text = readFileSync(cardPath, 'utf8');
  if (text.includes(MARK)) {
    skipped++;
    continue;
  }

  const chatBase = path.basename(r.source, '.md');
  const fmEnd = text.indexOf('\n---', 4); // front matter 结束位置
  const afterFm = fmEnd < 0 ? 0 : text.indexOf('\n', fmEnd + 1) + 1;
  const head = text.slice(0, afterFm);
  const rest = text.slice(afterFm);

  // 插到 H1 标题之后；没有 H1 就放在正文最前面
  const h1 = /^#\s+.*$/m.exec(rest);
  const line = `> 📄 **完整原文**：[[chats/${chatBase}|点击查看对话原文]]　（逐字保留提问·回答·深度思考，交由脚本从官方导出转换）\n`;
  let next;
  if (h1) {
    const at = h1.index + h1[0].length;
    next = head + rest.slice(0, at) + '\n\n' + line + rest.slice(at);
  } else {
    next = head + line + '\n' + rest;
  }

  if (!CHECK) writeFileSync(cardPath, next, 'utf8');
  changed++;
  done.push(`  ${r.id}  ${path.basename(r.note)}`);
}

console.log(`对话型卡片：新增原文链接 ${changed} 个${CHECK ? '（--check 未写入）' : ''}，已是新版跳过 ${skipped} 个`);
if (done.length) console.log(done.join('\n'));
