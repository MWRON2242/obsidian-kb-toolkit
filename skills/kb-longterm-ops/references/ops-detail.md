# 参考：运维细节与故障排查

> 由 `kb-longterm-ops` 按需加载；`SKILL.md` 只保留速查表与铁律。


# 知识库长线运营与更新

> 适用于"源文件 + 摘要卡 + 派生层"三层结构的本地知识库（参考实现：任意"原件 + 卡片 + 派生层"结构的本地库）。
> 所有命令在库根目录执行；**不要给原生命令加管道或重定向**（沙箱会拦，且 `> $null` 会让命令根本不执行）。

## 0. 一分钟速查：我该跑什么？

| 你做了什么 | 跑这几条 |
| --- | --- |
| 磁盘上多了文件 | `scan.mjs --root=<源>` → `extract-text.mjs --all` → 写卡片 → `link-notes.mjs` → `build-index.mjs` → `obsidian-sync.mjs` → `obsidian-check.mjs` |
| 只想刷新索引/首页 | `link-notes.mjs` → `build-index.mjs` → `obsidian-sync.mjs` |
| 加了新词条 | `extract-vocab.mjs` → `make-review-cards.mjs`（**只增不改**） |
| 加了手工材料（照片笔记/粘贴/CSV） | 存进 `inbox/` → `scan.mjs --root=inbox` → 写卡片 → 上面"刷新索引"三条 |
| 导入新一批对话导出 | `ds-chat-find.mjs --profile=<学科>` → `ds-chat-export.mjs --only=<ids>` → `scan.mjs --root=chats` → 子代理写卡 → 刷新索引 |
| 例行体检 | `obsidian-check.mjs` + `check-yaml.mjs --all` + `check-math.mjs` |
| 改了卡片里的公式 | `render-math-body.mjs` → `check-math.mjs` |
| 导出 Word/Excel 成品 | `export-csv-docx.mjs` 或 `lib-docx.mjs` → `check-docx.mjs` 验收 |

## 1. 四类新内容的接入路径

### 1.1 磁盘上出现新文件
```powershell
node tools/scan.mjs                 # 或 --root=<sources.json 里的 root id>
node tools/extract-text.mjs --all   # 抽正文到 cache/text/
# 读 cache/text/<id>.txt，写 notes/<id>-<slug>.md（长文档抽样读，别整篇读完）
node tools/link-notes.mjs           # 校验 + 回填 catalog（sha256/source/updated）
node tools/build-index.mjs
node tools/obsidian-sync.mjs
node tools/obsidian-check.mjs
```
**验收点**：`scan` 的"新增登记"数 == 你预期的文件数；`extract-text` 后 `needs-ocr` 只应有你说的那几个；`link-notes` 输出"规范校验通过 ✓"。

### 1.2 新的对话导出（DeepSeek 官方 ZIP）
```powershell
# 1) 解压后按学科检索（双门控：标题含强学科词 或 正文记号密度达标）
node tools/ds-chat-find.mjs "<导出目录>\conversations.json" --profile=math `
  --min-score=14 --exclude-title=物理竞赛,积木结构 --out="<导出目录>\math-ids.txt"
# 2) 导入（自动排除已导入的会话）
$ids = (Get-Content "<导出目录>\math-ids.txt" -Raw).Trim()
node tools/ds-chat-export.mjs "<导出目录>\conversations.json" --out="D:\...\知识库\chats" --only=$ids
# 3) 登记 + 分批建卡
node tools/scan.mjs --root=chats
node tools/ds-chat-batches.mjs --batches=5      # 只列尚未建卡的会话
```
**要点**：新学科先往 `tools/topic-profiles.json` 加档案（关键词/负向词/记号/强标题词）；`--probe-notation` 用来反向确认没漏掉"纯列表型"会话。

### 1.3 用户手工给的材料
存进 `inbox/`（**录入原件，照抄不改**）→ `scan.mjs --root=inbox` → 写卡片 → 刷新索引。
词条类材料（`英文 中文` 逐行）会被 `extract-vocab.mjs` 自动收进 `vocab/`。

### 1.4 要加一个新学科
1. `tools/topic-profiles.json` 加档案 → 2. 按 1.2 导入 → 3. 建卡（可并行子代理）→ 4. 写一个 `digest-<学科>.mjs` 汇总表 → 5. 首页会自动列出它。

## 2. 例行节奏

**每次改动后（必跑）**：`link-notes` → `build-index` → `obsidian-sync` → `obsidian-check`
**每周**：`check-yaml.mjs --all`、`check-math.mjs`、扫一遍库根有没有 0 字节空笔记
**每月**：备份（见 §7）、抽查 10% 卡片能回溯到原件、更新一次指标（§6）

## 3. 质量闸门（合并前自查）

| 检查项 | 命令 | 通过标准 |
| --- | --- | --- |
| 卡片字段/标签/长度 | `link-notes.mjs` | "规范校验通过 ✓"，无"正文偏长"（>1600 字） |
| front matter 语法 | `check-yaml.mjs` | 0 问题（含必填字段、重复键、引号配对、危险字符） |
| 公式可渲染性 | `check-math.mjs` | 可修层 0 处 |
| 链接/同名/空笔记 | `obsidian-check.mjs` | "健康检查通过 ✓" |
| Word 成品 | `check-docx.mjs <file>` | "docx 结构完好 ✓" |
| 复习卡增量安全 | `make-review-cards.mjs` 后看输出 | "新增 N，保留已有 M"，已有卡片数不减少 |

## 4. 目录权威速查（哪些能改）

| 目录 | 角色 | 能否手改 |
| --- | --- | --- |
| 磁盘原件（`D:\学习` 等） | **唯一权威** | ❌ 绝对禁止 |
| `chats/` | 官方导出转换的对话原文 | ❌ 脚本生成 |
| `inbox/` | 手工录入原件 | ⚠️ 录入后不改 |
| `cache/text/` | 抽取正文 | ❌ 可再生 |
| `notes/` | 摘要卡 | ✅ 可改 |
| `digests/` | 成品（含 Word/Excel） | ✅ 可改 |
| `materials/` `vocab/` | 逐字搬运的素材/词条 | ❌ 脚本重跑覆盖 |
| `review/` | **复习进度层** | ⚠️⚠️ **只增不改**，进度以 HTML 注释写在卡片行尾 |
| `index/` `fulltext/` `external/` | 派生索引 | ❌ 脚本生成 |

## 5. 故障排查表

| 症状 | 最可能原因 | 怎么办 |
| --- | --- | --- |
| 某条链接点不开 / 点了生成空笔记 | 写成了 `[[kb-0015]]`（只写 id），别名解析失败 | `fix-id-links.mjs` 批量改；删掉库根空笔记；`obsidian-check` 已把"只写 id"列为错误 |
| 属性面板里字段乱/消失 | front matter YAML 写坏（值里 `: `、` #`、以引号开头未闭合） | `check-yaml.mjs` 定位 → 修（整体加引号） |
| 公式显示成源码 | ①在属性里 ②在反引号里 ③行内跨行 ④奇数个 `$` | `check-math.mjs` 定位；卡片用 `render-math-body.mjs` 把公式搬进正文 |
| 首页没列出某个成品 | 成品不在 `digests/`，或名字以 `_` 开头 | `obsidian-sync.mjs` 会自动列 `digests/` 下的 md 与 docx/xlsx/pdf/csv |
| 复习卡不更新 | 新增了 `vocab/` 词条但没补卡 | `make-review-cards.mjs` |
| 复习进度归零 | 有脚本整体重写了 `review/*.md` | 立刻停止；从备份恢复；在 AGENTS 里重申"只增不改" |
| 抽取结果 0 字 | PDF 是扫描件 | 标 `needs-ocr`；需要内容再走 OCR 路线 |
| 抽出"成功"但全是乱码 | 字体缺 ToUnicode 映射 | 看 CJK 字符占比，低于 0.5 判失败 → `needs-ocr` |
| 分批导入后 manifest 少了记录 | 增量导出覆盖了清单 | 让下游读 `index/catalog.jsonl`（累积的），不要依赖 manifest |
| 目录里出现重复 id / 同名文件 | 生成器没加稳定前缀，或两次扫描重叠 | `obsidian-check` 报同名；删多余文件并改生成器 |

## 6. 指标看板（每月记一次）

```powershell
node -e "const fs=require('fs');const R=fs.readFileSync('index/catalog.jsonl','utf8').split(String.fromCharCode(10)).filter(Boolean).map(JSON.parse);const cards=fs.readdirSync('notes').length;const t={};for(const r of R)for(const x of r.tags||[])t[x]=(t[x]||0)+1;console.log('登记',R.length,'卡片',cards,'对话',R.filter(r=>r.root==='chats').length);console.log(Object.entries(t).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([k,v])=>k+' '+v).join(' | '))"
```
记录：登记数 / 卡片数 / 各层文件数（materials、vocab、review）/ 断链数 / 复习进度条数。
**趋势比绝对值重要**：卡片数连续两月不涨，说明新内容没进流水线。

## 7. 备份与回滚

**优先级（用户资产 > 可重建产物）**：
1. **必须备份**：`notes/`（手写卡片）、`review/`（复习进度）、`inbox/`（录入原件）、`index/tags.md`
2. **建议备份**：`index/catalog.jsonl`、`digests/`、`.obsidian/`（含插件与设置）
3. **不必备份**（可重跑）：`cache/`、`fulltext/`、`materials/`、`vocab/`

**回滚顺序**：先恢复 `notes/` 与 `review/` → 再跑 `link-notes` → `build-index` → `obsidian-sync` → 体检。
**注意**：`review/` 的进度只在卡片行里，**没有第二份**。若被覆盖，只能靠文件历史/备份。

## 8. 扩展边界与工具约定

- **可以随便重跑**：`scan` / `extract-text` / `extract-materials` / `extract-vocab` / `build-*` / `digest-*` / `obsidian-sync`（它们都只写派生层）
- **只增不改**：`make-review-cards.mjs`（保护复习进度）
- **加新工具时的三条约定**：① 提供 `--check`（只报告不写盘）；② 只读体检脚本永不修改文件；③ 新工具写进 `AGENTS.md` 的 §3.1 标准作业顺序，否则半年后没人记得要跑它
- **子代理批量的规模**：每批 5~8 篇、按字数均衡；子代理**只写 `notes/`**，`index/`/派生层由主控统一跑

## 9. 反模式（不要做）

1. 用管道/重定向跑原生命令（`| Out-String`、`> $null`）—— 要么报错，要么**静默不执行**
2. 整体重写 `review/` 或其他保存用户进度的文件
3. 把"渲染辅助小节"算进正文长度上限（会让所有数学卡假超限）
4. 让生成器清空整个派生目录（会误删别的脚本产物）
5. 把 `vocab/`、`materials/` 这类"可重建层"当权威来源去反驳原件
6. 全量跑一个没经过小样验证的新解析器
7. 靠肉眼确认产物可用（必须先有验收器）
