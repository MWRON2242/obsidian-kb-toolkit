#!/usr/bin/env node
/**
 * update-cards.mjs —— 单词数据一更新，就自动把卡片全部生成好（一条命令跑完整条链）
 *
 *   extract-vocab（重建 vocab/） → make-review-cards（只会新增，保护复习进度）
 *   → export-anki（导出 TSV） → anki-api import（Anki 在跑就直接推进去）
 *
 * 设计要点：
 *   · 子进程用 stdio:'inherit'（沙箱禁止给原生程序接管道，pipe 会 EPERM）
 *   · 不靠子进程的输出文字统计，而是**自己数前后差值**，结果可核对
 *   · 默认绝不 --rebuild：复习进度是用户资产
 *
 * 用法：
 *   node tools/update-cards.mjs                     # 全流程
 *   node tools/update-cards.mjs --dry               # 只报告会新增什么，不写盘
 *   node tools/update-cards.mjs --no-anki           # 不碰 Anki（只更新 Obsidian 复习卡）
 *   node tools/update-cards.mjs --scope=all         # Anki 导出全部词条（默认 照片笔记）
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const TOOLS = path.join(KB, 'tools');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const NO_ANKI = argv.includes('--no-anki');
const SCOPE = (argv.find((a) => a.startsWith('--scope=')) || '--scope=照片笔记').split('=')[1];
/** Anki 目标卡组：默认按 scope 推导，可用 --deck= 覆盖 */
const DECK = (argv.find((a) => a.startsWith('--deck=')) || '').split('=')[1] || (SCOPE === '照片笔记' ? '英语::照片笔记首背' : `英语::${SCOPE}`);
const ANKI_URL = 'http://127.0.0.1:8765';

const hr = (s) => console.log(`\n${'─'.repeat(4)} ${s} ${'─'.repeat(Math.max(0, 46 - s.length))}`);

function run(script, args = []) {
  console.log(`\n$ node tools/${script} ${args.join(' ')}`.trimEnd());
  const r = spawnSync(process.execPath, [path.join(TOOLS, script), ...args], { stdio: 'inherit', cwd: KB });
  if (r.status !== 0) {
    console.error(`\n✗ ${script} 失败（退出码 ${r.status}）—— 已停止后续步骤，避免半成品。`);
    process.exit(r.status || 1);
  }
}

/* ---------- 统计（不依赖子进程输出） ---------- */
const vocabStats = () => {
  const d = path.join(KB, 'vocab');
  if (!existsSync(d)) return { n: 0 };
  const files = readdirSync(d).filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== '词汇总表.md');
  const words = new Set();
  for (const f of files) {
    const m = /^word:\s*(.+)$/m.exec(readFileSync(path.join(d, f), 'utf8'));
    if (m) words.add(m[1].trim());
  }
  return { n: files.length, words };
};
const deckStats = () => {
  const d = path.join(KB, 'review');
  const out = { cards: 0, sr: 0, decks: [], other: 0 };
  if (!existsSync(d)) return out;
  for (const f of readdirSync(d).filter((f) => f.endsWith('.md'))) {
    const t = readFileSync(path.join(d, f), 'utf8');
    if (!/#flashcards/.test(t)) continue;
    const n = (t.match(/:::/g) || []).length;
    out.cards += n;
    out.sr += (t.match(/<!--SR:/g) || []).length;
    out.decks.push(`${f.replace(/\.md$/, '')}(${n})`);
    if (/^#flashcards\/英语\/其他$/m.test(t)) out.other = n;
  }
  return out;
};
const ankiReachable = async () => {
  try {
    const r = await fetch(ANKI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'version', version: 6 }),
    });
    const j = await r.json();
    return j.error ? null : j.result;
  } catch {
    return null;
  }
};
const ankiCount = async (tag = '首背') => {
  const r = await fetch(ANKI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'findCards', version: 6, params: { query: `tag:${tag}` } }),
  });
  const j = await r.json();
  return j.error ? null : j.result.length;
};

/* ---------- 开跑 ---------- */
console.log(`单词数据 → 卡片　${DRY ? '（dry-run，不写盘）' : ''}`);
console.log(`知识库：${KB}`);

const v0 = vocabStats();
const d0 = deckStats();
const api0 = NO_ANKI ? null : await ankiReachable();
const a0 = api0 ? await ankiCount() : null;

hr('1/4 搬运词条（vocab/ 整层重建）');
run('extract-vocab.mjs', DRY ? ['--check'] : []);

hr('2/4 生成 Obsidian 复习卡（只增不改，保护复习进度）');
run('make-review-cards.mjs', DRY ? ['--check'] : []);

hr(`3/4 导出 Anki 首背卡（范围：${SCOPE}）`);
run('export-anki.mjs', [`--scope=${SCOPE}`, ...(DRY ? ['--check'] : [])]);

const v1 = vocabStats();
const d1 = deckStats();
const base = SCOPE === 'all' ? '英语词汇-全部' : SCOPE;
const tsv = path.join(KB, 'digests', 'anki', `${base}-首背卡.tsv`);

hr('4/4 推进 Anki（经 AnkiConnect）');
let a1 = a0;
if (NO_ANKI) {
  console.log('已按 --no-anki 跳过。');
} else if (!api0) {
  console.log(`跳过：AnkiConnect 未响应（${ANKI_URL}）。`);
  console.log('  要自动导入：打开 Anki，确认已装插件（tools/install-anki-connect.mjs），再重跑本脚本。');
} else if (DRY) {
  console.log(`[dry] AnkiConnect 在线（API ${api0}），会导入 ${tsv.replace(KB + path.sep, '')} → 卡组「${DECK}」`);
} else {
  run('anki-api.mjs', ['import', `--tsv=${path.relative(KB, tsv)}`, `--deck=${DECK}`]);
  a1 = await ankiCount();
}

/* ---------- 汇总 ---------- */
hr('汇总');
const delta = (a, b) => (b - a > 0 ? `+${b - a}` : `${b - a}`);
console.log(`词条      ${v0.n} → ${v1.n}　(${delta(v0.n, v1.n)})`);
console.log(`复习卡    ${d0.cards} 张 → ${d1.cards} 张　(${delta(d0.cards, d1.cards)})　复习进度 ${d1.sr} 条（未动）`);
console.log(`牌组      ${d1.decks.join('　')}`);
if (a0 !== null) console.log(`Anki      ${a0} 张 → ${a1} 张　(${delta(a0, a1)})`);
else console.log('Anki      未连接');
if (d1.other > 0) {
  console.log(`\n⚠ 有 ${d1.other} 个词条落到了「其他」牌组 —— 说明出现了新的词条出处。`);
  console.log('  建议在 tools/make-review-cards.mjs 的 DECKS 里加一条映射，让它们单独成组。');
}
if (!DRY && d0.sr !== d1.sr) console.log(`\n⚠ 复习进度条数发生变化（${d0.sr} → ${d1.sr}）—— 这是不该发生的，请立刻检查 review/。`);
console.log('');
