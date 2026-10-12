#!/usr/bin/env node
/**
 * install-dep.mjs —— 绕过 npm 的最小依赖安装器
 *
 * 为什么存在：本机的 npm 启动器在受限环境下不可用（子进程管道被沙箱拒绝）。
 * 本脚本用 Node 自带的 https + zlib 直接下载并解开 npm 包 tarball（.tgz），
 * 只支持「无依赖或依赖已满足」的包，够本知识库使用。
 *
 * 用法：
 *   node tools/install-dep.mjs unpdf
 *   node tools/install-dep.mjs unpdf@1.8.1
 */
import https from 'node:https';
import zlib from 'node:zlib';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const TOOLS = path.resolve(import.meta.dirname);
const MODULES = path.join(TOOLS, 'node_modules');
const CACHE = path.join(TOOLS, '.deps-cache');

function get(url, binary = false) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { timeout: 60000, headers: { 'user-agent': 'kb-tools/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.destroy();
          resolve(get(res.headers.location, binary));
          return;
        }
        if (res.statusCode !== 200) {
          res.destroy();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve(binary ? buf : buf.toString('utf8'));
        });
        res.on('error', reject);
      })
      .on('timeout', () => reject(new Error('timeout')))
      .on('error', reject);
  });
}

/** 极简 tar 解析：只处理 ustar 常规文件与目录 */
function untar(buf) {
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    if (!name) break;
    const sizeField = header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const full = prefix ? `${prefix}/${name}` : name;
    off += 512;
    if (type === '0' || type === '\0' || type === '') {
      out.push({ name: full, data: buf.subarray(off, off + size) });
    }
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

const spec = process.argv[2];
if (!spec) {
  console.error('用法: node tools/install-dep.mjs <包名>[@版本]');
  process.exit(1);
}
const [pkg, wantVersion] = spec.includes('@') && !spec.startsWith('@')
  ? spec.split('@')
  : [spec, null];

console.log(`解析 ${pkg}${wantVersion ? `@${wantVersion}` : ''} ...`);
const meta = JSON.parse(await get(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`));
const version = wantVersion || meta['dist-tags'].latest;
const m = meta.versions[version];
if (!m) throw new Error(`找不到版本 ${version}`);

const deps = Object.keys(m.dependencies || {});
if (deps.length) {
  console.log(`注意：该包声明了依赖 ${deps.join(', ')}，本脚本不会自动安装；缺依赖时请手动补。`);
}

await mkdir(CACHE, { recursive: true });
const tgzPath = path.join(CACHE, `${pkg.replace('/', '__')}-${version}.tgz`);
let tgz;
try {
  tgz = await readFile(tgzPath);
  console.log(`使用缓存 ${path.relative(TOOLS, tgzPath)}`);
} catch {
  console.log(`下载 ${m.dist.tarball}`);
  tgz = await get(m.dist.tarball, true);
  await writeFile(tgzPath, tgz);
  console.log(`已缓存 ${(tgz.length / 1024 / 1024).toFixed(2)} MB`);
}

const files = untar(zlib.gunzipSync(tgz));
const destRoot = path.join(MODULES, pkg);
let written = 0;
for (const f of files) {
  const rel = f.name.replace(/^package\//, '');
  if (!rel || rel.endsWith('/')) continue;
  const target = path.join(destRoot, rel);
  if (!target.startsWith(destRoot)) continue; // 拒绝路径穿越
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, f.data);
  written++;
}
console.log(`✓ ${pkg}@${version} → ${path.relative(process.cwd(), destRoot)}  (${written} 个文件)`);
