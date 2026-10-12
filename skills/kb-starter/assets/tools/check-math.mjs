#!/usr/bin/env node
/**
 * check-math.mjs —— 检查库里的 LaTeX 数学公式能不能被 Obsidian 渲染
 *
 * Obsidian 内置 MathJax，支持四种定界符：$…$、$$…$$、\(…\)、\[…\]。
 * 但**位置**决定成败：
 *   ✅ 正文（阅读视图 / 实时预览）          → 渲染
 *   ❌ front matter（属性面板）              → 永远显示原文（Obsidian 不渲染属性）
 *   ❌ 行内代码 `…` 与代码块 ```…```          → 永远显示原文
 *   ❌ Bases 视图 / 搜索面板 / 反链面板        → 只显示纯文本
 *
 * chats/ 与 fulltext/ 是从官方导出逐字转换的**原文**，它们的问题只统计不列为待修。
 * 本脚本只做检查，不修改任何文件。
 *
 * 用法：node tools/check-math.mjs [--quiet]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const QUIET = process.argv.includes('--quiet');
const SCAN_DIRS = ['notes', 'digests', 'chats', 'materials', 'vocab', 'index', 'fulltext'];

/** 出现这些才算"含数学" */
const LATEX =
  /\\frac|\\sqrt|\\left|\\right|\\arctan|\\arccos|\\arcsin|\\lim|\\log|\\sum|\\int|\\pi|\\theta|\\alpha|\\beta|\\vec|\\overrightarrow|\\begin\{|\\text\{|\\mathbf|\\mathbb|\\cdot|\\implies|\\neq|\\geq|\\leq|\\times|\\pm|\\infty|\\boxed|\\displaystyle|\\cot|\\sinh|\\quad|\\subset|\\partial|\\nabla/;

/** 去掉 Windows 路径（D:\资料\(2020年…) —— 路径里的 \( 不是公式 */
const stripPaths = (t) => t.replace(/[A-Za-z]:\\[^\s`）)】]*/g, '');
const stripInlineCode = (t) => t.replace(/`[^`\n]*`/g, '');
const hasMath = (t) => {
  const s = stripPaths(stripInlineCode(t));
  return LATEX.test(s) || /\\\(|\\\[|\$\$/.test(s);
};

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

// 跳过派生报告（_开头），它们是脚本产物，本身会引用公式样本
const files = SCAN_DIRS.flatMap((d) => walk(path.join(KB, d))).filter((f) => !path.basename(f).startsWith('_'));
const isReadOnlyLayer = (rel) => /^(chats|fulltext)\//.test(rel);

const issues = [];
const readonly = [];
const stats = { scanned: files.length, mathFiles: 0, fmFiles: 0, fmLines: 0, codeOnly: 0, unbalanced: 0, ro: 0 };
const push = (rel, rec) => {
  if (isReadOnlyLayer(rel)) {
    stats.ro++;
    readonly.push(rec);
  } else {
    issues.push(rec);
  }
};

for (const f of files) {
  const rel = path.relative(KB, f).split(path.sep).join('/');
  const raw = readFileSync(f, 'utf8');
  const lines = raw.split(/\r?\n/);

  let fmEnd = -1;
  if (lines[0] === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '---') {
        fmEnd = i;
        break;
      }
    }
  }
  const fmLines = fmEnd > 0 ? lines.slice(1, fmEnd) : [];
  const bodyLines = fmEnd > 0 ? lines.slice(fmEnd + 1) : lines;

  if (!hasMath(raw)) continue;
  stats.mathFiles++;

  // ① front matter 里的公式
  const fmMath = fmLines.map((t, i) => ({ t, n: i + 2 })).filter((x) => hasMath(x.t));
  if (fmMath.length) {
    stats.fmFiles++;
    stats.fmLines += fmMath.length;
    issues.push({
      file: rel,
      kind: 'front-matter',
      detail: `front matter 里有 ${fmMath.length} 行含公式（第 ${fmMath.map((x) => x.n).join(', ')} 行）→ 属性面板只显示原文`,
      sample: fmMath[0].t.trim().slice(0, 90),
    });
  }

  // ② 正文：跳过代码围栏，逐行在"去掉路径与行内代码"后检查
  let inFence = false;
  const realLines = [];
  bodyLines.forEach((t, i) => {
    if (/^\s*```/.test(t)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    realLines.push({ t, n: (fmEnd > 0 ? fmEnd + 1 : 0) + i + 1, clean: stripPaths(stripInlineCode(t)) });
  });

  const bodyClean = realLines.map((x) => x.clean).join('\n');
  const c = (s, re) => (s.match(re) || []).length;

  // ②a 正文里完全没有公式（只有代码里有）→ 不会渲染
  if (!hasMath(bodyClean)) {
    stats.codeOnly++;
    issues.push({ file: rel, kind: 'code-only', detail: '公式只出现在代码块/行内代码/属性里 → 正文不会渲染', sample: '' });
  }

  // ②b 文件级配对
  const openP = c(bodyClean, /\\\(/g);
  const closeP = c(bodyClean, /\\\)/g);
  const openB = c(bodyClean, /\\\[/g);
  const closeB = c(bodyClean, /\\\]/g);
  const leftN = c(bodyClean, /\\left/g);
  const rightN = c(bodyClean, /\\right/g);
  if (openP !== closeP || openB !== closeB || leftN !== rightN) {
    push(rel, {
      file: rel,
      kind: 'unbalanced',
      detail: `定界符不配对：\\( ${openP} / \\) ${closeP}　\\[ ${openB} / \\] ${closeB}　\\left ${leftN} / \\right ${rightN}`,
      sample: '',
    });
  }

  // ②c 逐行：行内公式跨行、奇数个 $
  for (const { clean, n, t } of realLines) {
    const o = c(clean, /\\\(/g);
    const cl = c(clean, /\\\)/g);
    if (o !== cl) {
      push(rel, { file: rel, kind: 'inline-across-lines', detail: `第 ${n} 行的 \\( 与 \\) 不配对（行内公式不能跨行，请整段写在一行）`, sample: t.trim().slice(0, 90) });
    }
    const dollars = (clean.replace(/\$\$/g, '').match(/\$/g) || []).length;
    if (dollars % 2 === 1) {
      push(rel, { file: rel, kind: 'odd-dollar', detail: `第 ${n} 行有奇数个 $（${dollars} 个）→ 数学可能只渲染一半`, sample: t.trim().slice(0, 90) });
    }
  }
}

/* ---------- 输出 ---------- */
const byKind = {};
for (const i of issues) (byKind[i.kind] = byKind[i.kind] || []).push(i);
stats.unbalanced = (byKind.unbalanced?.length || 0) + (byKind['odd-dollar']?.length || 0) + (byKind['inline-across-lines']?.length || 0);

console.log(`扫描 ${stats.scanned} 个 md，其中含数学的 ${stats.mathFiles} 个`);
console.log(`① 公式在 front matter 里（属性面板不渲染，正文才会）：${stats.fmFiles} 个文件 / ${stats.fmLines} 行`);
console.log(`② 正文里没有公式、只在代码/属性里：${stats.codeOnly} 个文件`);
console.log(`③ 定界符待修（不配对 / 行内跨行 / 奇数 $）：${stats.unbalanced} 处，涉及 ${new Set(issues.filter((i) => i.kind !== 'front-matter' && i.kind !== 'code-only').map((i) => i.file)).size} 个文件`);
console.log(`④ 只读层同类问题（chats/ 与 fulltext/ 是逐字原文，不建议改）：${stats.ro} 处`);

const ORDER = ['unbalanced', 'odd-dollar', 'inline-across-lines', 'code-only'];
const TITLE = {
  unbalanced: '✗ 定界符不配对（会渲染失败或只渲染一半）',
  'odd-dollar': '✗ 奇数个 $（数学只渲染一半）',
  'inline-across-lines': '✗ 行内公式跨行（建议整段写一行）',
  'code-only': '⚠ 正文里没有公式（只写在代码块/属性里，不会渲染）',
};
for (const k of ORDER) {
  const list = byKind[k];
  if (!list?.length) continue;
  console.log(`\n${TITLE[k]}　共 ${list.length} 处`);
  const show = list.slice(0, QUIET ? 8 : 40);
  for (const i of show) {
    console.log(`  · ${i.file}　${i.detail}`);
    if (i.sample) console.log(`      ${i.sample}`);
  }
  if (list.length > show.length) console.log(`  …另有 ${list.length - show.length} 处`);
}
if (!issues.some((i) => i.kind !== 'front-matter')) {
  console.log('\n除"公式写在属性里"（已由 render-math-body.mjs 复制到正文）之外，没有其它渲染问题 ✓');
}
if (readonly.length) {
  console.log(`\n只读层同类问题（仅记录）示例：`);
  for (const r of readonly.slice(0, 3)) console.log(`  · ${r.file}　${r.detail}`);
}
