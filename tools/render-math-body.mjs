#!/usr/bin/env node
/**
 * render-math-body.mjs —— 让卡片里的数学公式真的被 Obsidian 渲染出来
 *
 * 问题：Obsidian 的 MathJax 只解析**正文**。而数学卡的公式基本都在 front matter 的
 * `key_points` / `quotes` 里 —— 属性面板（Properties）按设计只显示纯文本，
 * 于是你在属性里看到的永远是 `\arctan\left(\frac{-1-2a}{a+2}\right)` 这样的原文。
 *
 * 做法：把这些式子**原样搬一份到正文**的「公式速览（渲染用）」小节里，并把
 * 反引号代码标记 `` `\frac{a}{b}` `` 换成数学定界符 `$\frac{a}{b}$`（否则代码里的
 * 公式同样不渲染）。**只做这两件事，一个字都不改**；front matter 保持原样，
 * 所以卡片规范（key_points 等字段）不受影响。
 *
 * 幂等：重复运行只会重写这一小节。
 *
 * 用法：
 *   node tools/render-math-body.mjs --check   # 只报告会改哪些卡片
 *   node tools/render-math-body.mjs
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const NOTES = path.join(KB, 'notes');
const CHECK = process.argv.includes('--check');

const MARK = '## 公式速览（渲染用）';
const MATH = /\\frac|\\sqrt|\\left|\\right|\\arctan|\\arccos|\\arcsin|\\lim|\\log|\\sum|\\int|\\pi|\\theta|\\alpha|\\beta|\\vec|\\overrightarrow|\\begin\{|\\text\{|\\cdot|\\implies|\\neq|\\geq|\\leq|\\pm|\\infty|\\boxed|\\cot|\\sinh|\\subset|\\in\b|\\parallel|\\mid|\\displaystyle|\\Delta|\\mathbb/;

/** 把反引号里的 LaTeX 换成 $…$，其余原样 */
function toRenderable(s) {
  return s.replace(/`([^`]+)`/g, (m, inner) => {
    if (!MATH.test(inner)) return m; // 反引号里不是公式（如路径、字段名）就留着
    if (inner.includes('$')) return m; // 已经带定界符，别套两层
    return `$${inner}$`;
  });
}

/* ---------- 裸 LaTeX：把没有定界符的公式片段包进 $…$ ---------- */

/** 只认真正的 LaTeX 命令，避免把 D:\deepseek 这类路径里的反斜杠当公式 */
const CMD = /\\(?:frac|sqrt|left|right|vec|overrightarrow|lim|log|ln|sin|cos|tan|cot|sec|csc|arctan|arccos|arcsin|sinh|cosh|tanh|pi|theta|alpha|beta|gamma|delta|Delta|lambda|mu|sigma|omega|phi|varphi|epsilon|rho|tau|eta|nu|xi|zeta|psi|chi|kappa|iota|in|mid|parallel|perp|cdot|times|div|pm|mp|leq|geq|neq|approx|equiv|sim|simeq|propto|implies|iff|Rightarrow|Leftarrow|leftrightarrow|to|mapsto|infty|partial|nabla|sum|prod|int|oint|boxed|text|textbf|textit|mathbf|mathbb|mathcal|mathrm|displaystyle|quad|qquad|hfill|begin|end|cup|cap|subset|subseteq|supset|forall|exists|neg|land|lor|ldots|cdots|dots|circ|degree|prime|angle|triangle|cong|binom|choose|overline|underline|hat|bar|tilde|dot|ddot)\b/;

/** 构成"数学片段"的字符集合（含空格、正负号、希腊字母、≤≥√→∈∥⋅≠） */
const MCH = /[A-Za-z0-9\\{}[\]()_^=+\-*/.,|<>!':~$&%\s\u0370-\u03ff\u2190-\u2199\u2200-\u22ff\u2260\u2264\u2265\u00d7\u00b1\u2212]/;

/**
 * 把一行里"裸的"LaTeX 片段包上 $…$。
 * 例：`结论：1 + \frac{1}{x^2} 没有最小值` → `结论：$1 + \frac{1}{x^2}$ 没有最小值`
 */
function wrapBareLatex(line) {
  // 先保护已有的定界数学与行内代码，避免二次包裹
  const keep = [];
  const protectedLine = line
    .replace(/\\\([\s\S]*?\\\)/g, (m) => `\u0000${keep.push(m) - 1}\u0000`)
    .replace(/\\\[[\s\S]*?\\\]/g, (m) => `\u0000${keep.push(m) - 1}\u0000`)
    .replace(/\$\$[\s\S]*?\$\$/g, (m) => `\u0000${keep.push(m) - 1}\u0000`)
    .replace(/\$[^$\n]+\$/g, (m) => `\u0000${keep.push(m) - 1}\u0000`)
    .replace(/`[^`\n]*`/g, (m) => `\u0000${keep.push(m) - 1}\u0000`);

  // 按"数学字符"切出连续片段
  let out = '';
  let run = '';
  const flush = () => {
    if (!run) return;
    const t = run.trim();
    const isPath = /[A-Za-z]:\\/.test(t) || /\.(?:pdf|docx|doc|md|json|png|jpe?g|zip|xlsx|pptx|txt|exe)\b/i.test(t);
    if (t.length > 2 && CMD.test(t) && !isPath) {
      const lead = run.slice(0, run.indexOf(t[0]));
      const tail = run.slice(run.indexOf(t[0]) + t.length);
      out += `${lead}$${t}$${tail}`;
    } else {
      out += run;
    }
    run = '';
  };
  for (const ch of protectedLine) {
    if (ch === '\u0000' || MCH.test(ch)) run += ch;
    else {
      flush();
      out += ch;
    }
  }
  flush();

  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]);
}

const files = existsSync(NOTES) ? readdirSync(NOTES).filter((f) => f.endsWith('.md')) : [];
const changed = [];
const bareLatex = [];

for (const f of files) {
  const full = path.join(NOTES, f);
  const raw = readFileSync(full, 'utf8');
  const lines = raw.split(/\r?\n/);

  // 切 front matter
  let fmEnd = -1;
  if (lines[0] === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '---') {
        fmEnd = i;
        break;
      }
    }
  }
  if (fmEnd < 0) continue;
  const fm = lines.slice(1, fmEnd);
  const rest = lines.slice(fmEnd + 1);

  // 取 front matter 里含公式的列表项（key_points / quotes）
  const mathItems = fm
    .filter((t) => /^\s+-\s+/.test(t))
    .map((t) => t.replace(/^\s+-\s+/, '').trim())
    .filter((t) => MATH.test(t) || /\\\(|\\\[|\$/.test(t));
  if (!mathItems.length) continue;

  // 记录"裸 LaTeX"（整条既无定界符也无反引号，搬过去也不会渲染）
  for (const it of mathItems) {
    const hasDelim = /\\\(|\\\)|\\\[|\\\]|\$|`/.test(it);
    if (!hasDelim && MATH.test(it)) bareLatex.push(`${f}　${it.slice(0, 80)}`);
  }

  const section = [
    MARK,
    '',
    '> 以下式子从卡片属性（`key_points` / `quotes`）**原样搬来**，只做了两件事：把反引号代码标记换成数学定界符、给没有定界符的式子补上 `$…$` —— 属性面板不渲染数学，正文才会。要改内容请改卡片属性。',
    '',
    ...mathItems.map((t) => `- ${wrapBareLatex(toRenderable(t))}`),
    '',
    '',
  ];

  // 替换已有小节或插入到「关联」之前
  const body = rest.join('\n');
  let next;
  const at = body.indexOf(MARK);
  if (at >= 0) {
    const after = body.slice(at);
    const nextHeading = after.slice(MARK.length).search(/\n## /);
    const end = nextHeading < 0 ? body.length : at + MARK.length + nextHeading + 1;
    next = body.slice(0, at) + section.join('\n') + body.slice(end);
  } else {
    const linkAt = body.indexOf('\n## 关联');
    if (linkAt >= 0) next = body.slice(0, linkAt + 1) + section.join('\n') + body.slice(linkAt + 1);
    else next = body.replace(/\s*$/, '\n\n') + section.join('\n');
  }

  const out = [lines[0], ...fm, lines[fmEnd], ...next.split('\n')].join('\n');
  if (out !== raw) {
    changed.push({ file: f, items: mathItems.length });
    if (!CHECK) writeFileSync(full, out, 'utf8');
  }
}

console.log(`扫描 notes/ 下 ${files.length} 张卡片`);
console.log(`${CHECK ? '将会修改' : '已修改'} ${changed.length} 张卡片（把 front matter 里的公式搬进正文的「${MARK.replace('## ', '')}」小节）`);
for (const c of changed) console.log(`  ${c.file}　${c.items} 条公式`);
if (bareLatex.length) {
  console.log(`\nℹ ${bareLatex.length} 条公式在**属性里**是"裸 LaTeX"（没有定界符）—— 正文里已自动补上 $…$，但属性面板照旧只显示原文：`);
  for (const b of bareLatex.slice(0, 20)) console.log(`  · ${b}`);
  if (bareLatex.length > 20) console.log(`  …另有 ${bareLatex.length - 20} 条`);
}
