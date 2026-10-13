#!/usr/bin/env node
/**
 * install-anki-connect.mjs —— 把 AnkiConnect 插件装进本机 Anki（用于脚本化导入卡片）
 *
 * 为什么需要它：AnkiConnect 提供 http://127.0.0.1:8765 的本地接口，
 * 有了它才能用脚本建卡组 / 建卡片类型 / 批量加卡片，而不用你手点。
 * 本机 Anki 的 addons21 是空的，所以这里直接从 GitHub 下载源码 zip 解出 plugin/ 放进去。
 *
 * ⚠️ 装完必须**重启 Anki** 才会加载插件。
 *
 * 用法：node tools/install-anki-connect.mjs [--check]
 */
import { writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const CHECK = process.argv.includes('--check');
const ADDON_CODE = '2055492159'; // AnkiConnect 的官方 add-on code
const DATA = path.join(process.env.APPDATA || '', 'Anki2');
const ADDONS = path.join(DATA, 'addons21');
const DEST = path.join(ADDONS, ADDON_CODE);

/* ---------- 极简 ZIP 解包（只用到 deflate + store） ---------- */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法的 zip（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < count; k++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const lho = buf.readUInt32LE(p + 42);
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + compSize);
    const isDir = name.endsWith('/');
    out.push({ name, isDir, data: isDir ? null : method === 8 ? zlib.inflateRawSync(raw) : raw });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

console.log(`Anki 数据目录：${DATA}`);
console.log(`插件目录：${ADDONS}`);
if (!existsSync(ADDONS)) {
  console.error('✗ addons21 目录不存在 —— 先启动一次 Anki 让它建出来。');
  process.exit(1);
}
if (existsSync(DEST) && readdirSync(DEST).length) {
  console.log(`✓ 已经装过（${path.relative(DATA, DEST)}），无需重复安装。`);
  console.log('  若接口不通，重启一次 Anki 即可。');
  process.exit(0);
}
if (CHECK) {
  console.log('[check] 未安装，需要下载安装。');
  process.exit(0);
}

const URLS = [
  'https://codeload.github.com/FooSoft/anki-connect/zip/refs/heads/master',
  'https://codeload.github.com/FooSoft/anki-connect/zip/refs/heads/main',
];
let zipBuf = null;
for (const u of URLS) {
  try {
    const r = await fetch(u, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) {
      console.log(`  跳过 ${u}（HTTP ${r.status}）`);
      continue;
    }
    zipBuf = Buffer.from(await r.arrayBuffer());
    console.log(`✓ 已下载 ${(zipBuf.length / 1024).toFixed(0)} KB  ←  ${u}`);
    break;
  } catch (e) {
    console.log(`  失败 ${u}：${e.message}`);
  }
}
if (!zipBuf) {
  console.error('✗ 下载失败。可手动安装：Anki → 工具 → 插件 → 获取插件 → 输入 2055492159 → 确定 → 重启');
  process.exit(1);
}

const entries = unzip(zipBuf);
// 仓库源码里没有 manifest.json（打包脚本只 zip plugin/*，靠 Anki 的兼容逻辑），
// 所以这里补一个标准 manifest：name + package(=官方 add-on code)，不设版本上下限以最大化兼容。
const MANIFEST = {
  name: 'AnkiConnect',
  package: ADDON_CODE,
  mod: 0,
  conflicts: [],
};
if (process.argv.includes('--list')) {
  console.log('zip 内条目：');
  for (const e of entries) console.log('  ' + e.name);
  console.log('\n将写入的 manifest.json：');
  console.log(JSON.stringify(MANIFEST, null, 2));
  process.exit(0);
}
const catArg = (process.argv.find((a) => a.startsWith('--cat=')) || '').slice(6);
if (catArg) {
  const hit = entries.find((e) => e.name === catArg || e.name.endsWith('/' + catArg));
  if (!hit) {
    console.error('找不到条目：' + catArg);
    process.exit(1);
  }
  console.log(`--- ${hit.name} ---`);
  console.log(hit.data.toString('utf8'));
  process.exit(0);
}
const prefix = 'anki-connect-master/plugin/';
let n = 0;
for (const e of entries) {
  if (!e.name.startsWith(prefix) || e.name === prefix) continue;
  const rel = e.name.slice(prefix.length);
  if (!rel) continue;
  const dest = path.join(DEST, ...rel.split('/'));
  if (e.isDir) {
    mkdirSync(dest, { recursive: true });
    continue;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, e.data);
  n++;
}
writeFileSync(path.join(DEST, 'manifest.json'), JSON.stringify(MANIFEST, null, 2), 'utf8');
n++;
console.log(`✓ 已装到 ${path.relative(DATA, DEST)}（${n} 个文件，含补写的 manifest.json）`);
console.log(`
下一步（必须）：**重启 Anki** —— 插件只在启动时加载。
  重启后 http://127.0.0.1:8765 才会响应，然后就能脚本化导入了。`);
