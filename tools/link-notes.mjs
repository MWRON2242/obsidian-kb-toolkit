#!/usr/bin/env node
/**
 * link-notes.mjs —— 把 notes/ 里的摘要卡与 catalog 建立双向关联并做规范校验
 *
 * 职责（脚本拥有 catalog 的 note/status/tags/sha256 字段，避免人工手改目录）：
 *   1. 解析每张卡片的 YAML front matter；
 *   2. 校验 id 存在、source 与原件一致、tags 在 index/tags.md 词表内；
 *   3. 回填 catalog 的 note / tags / sha256，并把状态推进到 noted；
 *   4. 报告缺字段、非法标签、正文过长等问题（不自动改写正文）。
 *
 * 用法：
 *   node tools/link-notes.mjs            # 校验 + 回填
 *   node tools/link-notes.mjs --check    # 只校验，不写 catalog
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const CATALOG = path.join(KB, 'index', 'catalog.jsonl');
const NOTES = path.join(KB, 'notes');
const TAGS = path.join(KB, 'index', 'tags.md');

const check = process.argv.includes('--check');

const vocab = new Set(
  (await readFile(TAGS, 'utf8'))
    .split(/\r?\n/)
    .map((l) => /^\|\s*`([^`]+)`\s*\|/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]),
);

const records = (await readFile(CATALOG, 'utf8'))
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
const byId = new Map(records.map((r) => [r.id, r]));

function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fields: {}, body: text, hasFM: false };
  const fields = {};
  const listKeys = new Set();
  let current = null;
  for (const raw of m[1].split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (kv) {
      current = kv[1];
      let v = kv[2].trim();
      if (v.startsWith('[') && v.endsWith(']')) {
        fields[current] = v
          .slice(1, -1)
          .split(',')
          .map((x) => x.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
      } else {
        fields[current] = v.replace(/^["']|["']$/g, '');
      }
      continue;
    }
    const li = /^\s*-\s+(.*)$/.exec(raw);
    if (li && current) {
      if (!listKeys.has(current)) {
        fields[current] = [];
        listKeys.add(current);
      }
      if (!Array.isArray(fields[current])) fields[current] = [fields[current]].filter(Boolean);
      fields[current].push(li[1].trim());
    }
  }
  return { fields, body: text.slice(m[0].length), hasFM: true };
}

if (!existsSync(NOTES)) {
  console.log('notes/ 目录还不存在，没有卡片可关联。');
  process.exit(0);
}

const files = (await readdir(NOTES)).filter((f) => f.endsWith('.md'));
const problems = [];
const linked = [];
let updatedCount = 0;

for (const f of files) {
  const full = path.join(NOTES, f);
  const text = await readFile(full, 'utf8');
  const { fields, body, hasFM } = parseFrontMatter(text);
  const where = `notes/${f}`;

  if (!hasFM) {
    problems.push(`${where}: 缺少 YAML front matter`);
    continue;
  }
  for (const key of ['id', 'title', 'source', 'source_type', 'tags', 'status', 'summary']) {
    if (!fields[key] || (Array.isArray(fields[key]) && !fields[key].length)) {
      problems.push(`${where}: 缺少必填字段 ${key}`);
    }
  }
  const rec = fields.id ? byId.get(fields.id) : null;
  if (!rec) {
    problems.push(`${where}: id "${fields.id}" 不在 catalog 中`);
    continue;
  }
  // source / sha256 以 catalog 为唯一权威，直接改写卡片里的对应行（不信任手抄值）
  let fixed = text;
  const setLine = (key, value) => {
    const re = new RegExp(`^${key}:.*$`, 'm');
    if (re.test(fixed)) fixed = fixed.replace(re, `${key}: ${value}`);
    else fixed = fixed.replace(/^---\r?\n/, (m) => `${m}${key}: ${value}\n`);
  };
  if (fields.source && path.resolve(fields.source) !== path.resolve(rec.source)) {
    problems.push(`${where}: source 与 catalog 不一致，已按 catalog 改写（原值 ${fields.source}）`);
  }
  setLine('source', rec.source);
  setLine('sha256', rec.sha256 || '');
  setLine('updated', new Date().toISOString().slice(0, 10));
  if (fixed !== text && !check) await writeFile(full, fixed, 'utf8');
  const tags = Array.isArray(fields.tags) ? fields.tags : fields.tags ? [fields.tags] : [];
  const bad = tags.filter((t) => !vocab.has(t));
  if (bad.length) problems.push(`${where}: 使用了词表外的标签 ${bad.join(', ')}（请先在 index/tags.md 申报）`);
  if (tags.length < 2) problems.push(`${where}: 标签少于 2 个`);

  // 「公式速览（渲染用）」是把 front matter 里的公式搬进正文的**渲染辅助小节**，
  // 内容与 key_points 逐字重复，不参与正文长度统计（否则数学卡会全部"超限"）。
  const bodyNoMath = body.replace(/## 公式速览（渲染用）[\s\S]*?(?=\n## |$)/, '');
  const bodyText = bodyNoMath.replace(/^#.*$/gm, '').trim();
  if (bodyText.length > 1600) problems.push(`${where}: 正文偏长（${bodyText.length} 字），建议压缩到 1600 以内`);

  const kp = fields.key_points;
  if (!kp || (Array.isArray(kp) && kp.length < 2)) problems.push(`${where}: key_points 至少 2 条`);
  if (Array.isArray(kp) && kp.length > 7) problems.push(`${where}: key_points 有 ${kp.length} 条，超过上限 7 条（请合并）`);

  // 隐私嗅探：卡片里不该出现完整手机号/身份证号（原件里有就留在原件里）
  const privacy = [];
  const phone = /\b1[3-9]\d{9}\b/g;
  const idcard = /\b\d{17}[\dXx]\b/g;
  for (const m of text.matchAll(phone)) privacy.push(`手机号 ${m[0].slice(0, 3)}****${m[0].slice(-4)}`);
  for (const m of text.matchAll(idcard)) privacy.push(`身份证号 ${m[0].slice(0, 4)}****${m[0].slice(-4)}`);
  if (privacy.length) {
    problems.push(`${where}: 发现未脱敏个人信息 ${privacy.join('、')}（请在卡片中打码，原件保留原样）`);
  }

  // 回填：catalog 是 note/status/sha256/tags 的所有者
  rec.note = where;
  rec.tags = [...new Set([...(rec.tags || []), ...tags])].filter((t) => vocab.has(t));
  rec.sha256 = rec.sha256 || fields.sha256 || null;
  // 卡片自称的「特殊状态」（如乱码只能 OCR）优先于默认的 noted
  const SPECIAL = ['needs-ocr', 'missing', 'duplicate', 'deferred'];
  const cardStatus = Array.isArray(fields.status) ? fields.status[0] : fields.status;
  if (SPECIAL.includes(cardStatus)) rec.status = cardStatus;
  else if (!['missing', 'duplicate', 'deferred'].includes(rec.status)) rec.status = 'noted';
  rec.updated = new Date().toISOString().slice(0, 10);
  updatedCount++;
  linked.push({ id: rec.id, file: where, tags: rec.tags, chars: bodyText.length });
}

if (!check) {
  records.sort((a, b) => a.id.localeCompare(b.id));
  await writeFile(CATALOG, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

console.log(`扫描卡片 ${files.length} 张，成功关联 ${linked.length} 张${check ? '（--check 未写入）' : '，已回填 catalog'}`);
for (const l of linked) console.log(`  ${l.id}  ${l.file}  #${l.tags.join(' #')}  正文 ${l.chars} 字`);

if (problems.length) {
  console.log(`\n发现 ${problems.length} 个规范问题：`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  if (!check) {
    console.log('\n提示：问题项仍已关联，但请修正后再验收。');
  }
  process.exitCode = 2;
} else {
  console.log('\n规范校验通过 ✓');
}

const withoutNote = records.filter((r) => !r.note && r.status === 'registered');
if (withoutNote.length) {
  console.log(`\n仍有 ${withoutNote.length} 条已登记但无摘要卡：${withoutNote.slice(0, 10).map((r) => r.id).join(', ')}${withoutNote.length > 10 ? ' ...' : ''}`);
}
