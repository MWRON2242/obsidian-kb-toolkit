#!/usr/bin/env node
/**
 * report-found.mjs —— 把 find-docs.mjs 的结果分门别类，区分「真文档」与「噪音」
 *
 * 只读 index/found-docs.json，不碰任何原件。
 * 用法：node tools/report-found.mjs [--top=8]
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const SRC = path.join(KB, 'index', 'found-docs.json');
const argv = process.argv.slice(2);
const arg = (n, dflt) => (argv.find((a) => a.startsWith(`${n}=`)) || `${n}=${dflt}`).split('=')[1];
const TOP = Number(arg('--top', 8));
const DEPTH = Number(arg('--depth', 3));
const ONLY = arg('--only', '').split(',').filter(Boolean);

if (!existsSync(SRC)) {
  console.error('没有 index/found-docs.json，请先运行 node tools/find-docs.mjs');
  process.exit(1);
}
const data = JSON.parse(readFileSync(SRC, 'utf8'));
const items = data.items;

/** 噪音判定：源码/工具自带的许可证、模板、构建产物 */
const NOISE_PATH = /(\\|\/)(keil\d?|libraries|cmsis|node_modules|\.codex|\.git|plugins(\\|\/)cache|site-packages|vendor|third_party|__pycache__)(\\|\/)/i;
const NOISE_NAME = /^(~\$|license|licence|readme|reference|doc1|新建 microsoft word|新建文档|template|模板)\.?(doc|docx|rtf|dotx?)?$/i;
const NOISE_PREFIX = /^~\$/; // Word 临时锁文件（打开文档时生成，关掉就没了）

const CATS = [
  {
    key: 'wechat',
    label: '微信/QQ 接收文件',
    test: (p) => /xwechat_files|wechat files|qq[\\/]|\\msg[\\/]file/i.test(p),
    note: '工作往来文件，时效性强、重复版本多',
  },
  {
    key: 'noise',
    label: '源码/工具自带（噪音）',
    test: (p, n) => NOISE_PATH.test(p) || NOISE_NAME.test(n) || NOISE_PREFIX.test(n),
    note: 'Keil 工程的 License.doc、插件模板等，不必入库',
  },
  {
    key: 'class',
    label: '班级研究性学习课题',
    test: (p) => /^D:\\20(23|24)高一/.test(p),
    note: '整班提交的课题材料，每人一份同名文件',
  },
  {
    key: 'project',
    label: '工程资料（jeff / zump）',
    test: (p) => /^D:\\(jeff|zump)\\/i.test(p),
    note: '历史项目归档，zump 疑似 jeff 的副本',
  },
  {
    key: 'userdoc',
    label: '用户文档（Documents / Desktop）',
    test: (p) => /\\Documents\\|\\Desktop\\|\\桌面\\/i.test(p),
    note: '真正的个人/工作文档主战场',
  },
  {
    key: 'other',
    label: '其他位置',
    test: () => true,
    note: '零散分布于其它目录',
  },
];

for (const it of items) {
  const cat = CATS.find((c) => c.test(it.path, it.name));
  it.cat = cat.key;
}
const byCat = new Map(CATS.map((c) => [c.key, []]));
for (const it of items) byCat.get(it.cat).push(it);

console.log(`总计 ${items.length} 个 Word 文档，${(data.stats.bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`扫描时间 ${data.scannedAt.slice(0, 19).replace('T', ' ')}　根目录 ${data.roots.join('、')}\n`);

for (const c of CATS) {
  const list = byCat.get(c.key);
  if (!list.length) continue;
  if (ONLY.length && !ONLY.includes(c.key)) continue;
  const bytes = list.reduce((a, i) => a + i.bytes, 0);
  const reg = list.filter((i) => i.registered).length;
  console.log(`===== ${c.label}：${list.length} 个 / ${(bytes / 1024 / 1024).toFixed(1)} MB（已入库 ${reg}）`);
  console.log(`      ${c.note}`);

  // 该类别下按目录再分组，看清聚集点
  const sub = new Map();
  for (const it of list) {
    const parts = it.path.split(path.sep).filter(Boolean);
    const g = parts.slice(0, Math.min(DEPTH, parts.length - 1)).join('\\') + '\\';
    if (!sub.has(g)) sub.set(g, []);
    sub.get(g).push(it);
  }
  for (const [g, v] of [...sub].sort((a, b) => b[1].length - a[1].length).slice(0, TOP)) {
    const gb = v.reduce((a, i) => a + i.bytes, 0);
    console.log(`      ${String(v.length).padStart(4)} 个  ${(gb / 1024 / 1024).toFixed(1).padStart(6)} MB  ${g}`);
    if (DEPTH >= 5) {
      const names = v
        .slice()
        .sort((a, b) => b.mtime.localeCompare(a.mtime))
        .slice(0, 3)
        .map((i) => `${i.name}(${i.mtime})`);
      console.log(`            最新：${names.join('、')}`);
    }
  }
  if (sub.size > TOP) console.log(`      ... 另有 ${sub.size - TOP} 个子目录`);

  // 组内同名重复（同文件名 + 同大小，基本可判定为同一份文件的多个副本）
  const keys = new Map();
  for (const it of list) {
    const k = `${it.name.toLowerCase()}|${it.bytes}`;
    if (!keys.has(k)) keys.set(k, []);
    keys.get(k).push(it.path);
  }
  const dup = [...keys].filter(([, v]) => v.length > 1);
  const dupCount = dup.reduce((a, [, v]) => a + v.length - 1, 0);
  if (dup.length) console.log(`      ↳ 其中 ${dupCount} 个是「同名同大小」的重复副本（${dup.length} 组）`);
  console.log('');
}

const real = items.filter((i) => i.cat !== 'noise');
const realUnreg = real.filter((i) => !i.registered);
console.log('===== 汇总 =====');
console.log(`噪音（源码许可证/模板）：${items.length - real.length} 个`);
console.log(`真文档：${real.length} 个，其中尚未入库 ${realUnreg.length} 个`);
const years = new Map();
for (const it of real) {
  const y = it.mtime.slice(0, 4);
  years.set(y, (years.get(y) || 0) + 1);
}
console.log(`按修改年份：${[...years].sort().map(([y, n]) => `${y} ${n}`).join('　')}`);
