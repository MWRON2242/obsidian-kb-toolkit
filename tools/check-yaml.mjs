#!/usr/bin/env node
/**
 * check-yaml.mjs —— 摘要卡 front matter 的 YAML 语法体检
 *
 * 为什么需要它：187 张卡片的 front matter 是手写 + 脚本回填混在一起的，
 * 一旦 YAML 写坏（值里出现 ": "、" #"、制表符、未闭合的引号/方括号），
 * Obsidian 的属性面板就会显示异常或把字段丢进"未识别属性"。
 *
 * 只做检查，不修改文件。
 * 用法：
 *   node tools/check-yaml.mjs             # 检查 notes/
 *   node tools/check-yaml.mjs --all       # 同时检查 inbox/ 与 digests/
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const ALL = process.argv.includes('--all');

const TARGETS = [
  { dir: path.join(KB, 'notes'), label: 'notes/' },
  ...(ALL
    ? [
        { dir: path.join(KB, 'inbox'), label: 'inbox/' },
        { dir: path.join(KB, 'digests'), label: 'digests/' },
        { dir: path.join(KB, 'materials'), label: 'materials/' },
        { dir: path.join(KB, 'vocab'), label: 'vocab/' },
      ]
    : []),
];

const REQUIRED = ['id', 'title', 'source', 'source_type', 'tags', 'status', 'summary'];
/** 未加引号的 YAML 标量里，这些模式会让解析器误判 */
const RISKY = [
  { re: /: /, why: '值里含"冒号+空格"，YAML 会当成嵌套映射' },
  { re: / #/, why: '值里含"空格+井号"，会被当成注释截断' },
  { re: /\t/, why: '值里有制表符' },
  { re: /^[-?] /, why: '值以"- "或"? "开头，会被当成列表/复杂键' },
  { re: /^[&*!%@`>|]/, why: '值以 YAML 特殊字符开头，需加引号' },
];

let files = 0;
let problems = 0;
const byFile = [];

for (const { dir, label } of TARGETS) {
  if (!existsSync(dir)) continue;
  // 只有 notes/ 是"摘要卡"（必须满足卡片字段规范）；inbox/materials/vocab/digests
  // 各有自己的字段体系（kb_inbox / kb_material / kb_vocab），只检查 YAML 语法。
  const isCards = label === 'notes/';
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || f.startsWith('_')) continue;
    files++;
    const rel = `${label}${f}`;
    const raw = readFileSync(path.join(dir, f), 'utf8');
    const lines = raw.split(/\r?\n/);
    const issues = [];

    if (lines[0] !== '---') {
      if (isCards) issues.push('开头不是 ---，没有 front matter');
    } else {
      let end = -1;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i] === '---') {
          end = i;
          break;
        }
      }
      if (end < 0) issues.push('front matter 没有闭合的 ---');

      const keys = new Map();
      if (end > 0) {
        lines.slice(1, end).forEach((l, i) => {
          const n = i + 2;
          if (!l.trim()) return;
          if (/^\s+-\s/.test(l)) {
            // 列表项：检查是否有值
            if (!l.replace(/^\s+-\s/, '').trim()) issues.push(`第 ${n} 行：列表项为空`);
            return;
          }
          const kv = /^([A-Za-z_][\w-]*):(.*)$/.exec(l);
          if (!kv) {
            issues.push(`第 ${n} 行：不是合法的「键: 值」行 → ${l.slice(0, 50)}`);
            return;
          }
          const [key, rest] = [kv[1], kv[2]];
          const val = rest.replace(/^\s+/, '');
          if (keys.has(key)) issues.push(`第 ${n} 行：键 ${key} 重复（前面第 ${keys.get(key)} 行已出现）`);
          else keys.set(key, n);
          if (!val) return; // 空值 = 后面跟多行列表，正常
          // 行内数组：检查方括号配对
          if (val.startsWith('[')) {
            if (!val.endsWith(']')) issues.push(`第 ${n} 行：${key} 的行内数组没有闭合的 ]`);
            return;
          }
          if (val.startsWith('{')) {
            if (!val.endsWith('}')) issues.push(`第 ${n} 行：${key} 的行内映射没有闭合的 }`);
            return;
          }
          // 引号：未加引号的普通标量里可以自由出现引号（YAML 允许），
          // 只有"以引号开头却没配对"才是真错误。
          const q = val[0];
          if ((q === '"' || q === "'") && !(val.length > 1 && val.endsWith(q) && (val.match(new RegExp(q, 'g')) || []).length % 2 === 0)) {
            issues.push(`第 ${n} 行：${key} 以 ${q} 开头但引号没有正确闭合`);
          }
          for (const { re, why } of RISKY) {
            if (re.test(val)) issues.push(`第 ${n} 行：${key} —— ${why}`);
          }
        });
      }

      // 必填字段（只对摘要卡）
      if (isCards) {
        for (const k of REQUIRED) {
          if (!keys.has(k)) issues.push(`缺少必填字段 ${k}`);
        }
      }
      // status 取值
      const st = /^status:[ \t]*(.*)$/m.exec(raw);
      if (st && !['registered', 'noted', 'verified', 'needs-ocr', 'missing', 'duplicate', 'deferred'].includes(st[1].trim())) {
        issues.push(`status 取值不在允许集合内：${st[1].trim()}`);
      }
    }

    if (issues.length) {
      problems += issues.length;
      byFile.push({ rel, issues });
    }
  }
}

console.log(`检查 ${files} 个 markdown 文件的 front matter`);
console.log(`YAML 问题：${problems} 处，涉及 ${byFile.length} 个文件`);
for (const { rel, issues } of byFile.slice(0, 30)) {
  console.log(`\n  ${rel}`);
  for (const i of issues.slice(0, 6)) console.log(`    · ${i}`);
  if (issues.length > 6) console.log(`    …另有 ${issues.length - 6} 处`);
}
if (byFile.length > 30) console.log(`\n…另有 ${byFile.length - 30} 个文件有问题`);
if (!problems) console.log('\n所有 front matter 语法正确 ✓');
