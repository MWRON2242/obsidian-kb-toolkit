# AGENTS.md —— 知识库硬规则

> 本目录是**个人知识库 + Obsidian vault**。违反下列规则视为错误修改。
> 用法细节见 `README.md`；例行运维与故障排查见 skill **`kb-longterm-ops`**；建库踩坑见 **`kb-starter`**。

## 1. 绝对禁止

1. 禁止修改/移动/删除**任何原件**（你的资料目录，如 `D:\学习`、`D:\论文`；以及 D 盘根目录下的散落文档）。润色/改写一律**产出新文件**。
2. 禁止手改 `index/catalog.jsonl`、`cache/text/`、`fulltext/`（脚本重建）。
3. 禁止把摘要卡当事实来源；结论必须能回溯原件，否则标 `[未核实]`。
4. 禁止臆造原文：抽取 0 字或乱码 → 状态标 `needs-ocr`，**不凭文件名编内容**。

## 2. 权威层级与目录

`原件 > notes/ 摘要卡 > index/ 派生索引`。冲突以原件为准，并立刻修正卡片。

| 目录 | 角色 | 手改 |
| --- | --- | --- |
| 磁盘原件 | 唯一权威 | ❌ |
| `chats/` `cache/text/` `fulltext/` `external/` `index/` | 可再生派生 | ❌ 脚本生成 |
| `inbox/` | 手工录入原件（照片笔记/粘贴/CSV） | ⚠️ 录入后不改 |
| `materials/` `vocab/` | 逐字搬运层（素材·词条） | ❌ 脚本重跑覆盖 |
| `review/` | **复习进度层** | ⚠️⚠️ **只增不改**（进度以 HTML 注释写在卡片行尾） |
| `notes/` `digests/` | 摘要卡与成品（含 Word/Excel） | ✅ |

## 3. 摘要卡规范

- 位置 `notes/<id>-<slug>.md`；front matter 必填 `id/title/source/source_type/tags/status/created/updated/sha256/summary/key_points`（`quotes` 可选）。
- `key_points` **3~7 条**；正文 **≤600 字**（长文档 ≤1600）；标签只用 `index/tags.md` 词表，每卡 2~4 个且至少 1 个学科/类型标签。
- `source`/`sha256` 由 `link-notes.mjs` 以 catalog 回填 —— 留空即可，**不要写与 catalog 不同的值**。
- **公式写正文**（属性面板不渲染 Markdown 也不渲染数学）：`$…$` / `$$…$$`，**别包反引号**，行内不跨行；表格里绝对值写 `\lvert x \rvert`。属性里的公式由 `render-math-body.mjs` 自动复制到正文的「公式速览」小节。

## 4. Obsidian 约束

- **文件名全库唯一**；链接一律 `[[完整文件名|显示文本]]`，**绝不只写 `[[kb-0015]]`** —— 别名解析失败会在库根新建空笔记并反过来抢走解析。批量修：`fix-id-links.mjs`。
- 表格里用 Markdown 链接 `[标题](notes/x.md)`（免去转义竖线）。
- 改文本文件**禁用** PowerShell `Set-Content`/`Out-File`（PS 5.1 写 BOM 会毁 front matter）；用 `write`/`edit` 工具或 Node 脚本。
- 指向"已登记未建卡"的 `[[kb-XXXX]]` 是**待建卡提示**，不是错误。

## 5. 标准流程

```powershell
node tools/scan.mjs                    # 有新文件先登记（--root=<源 id>）
node tools/extract-text.mjs --all      # 抽正文到 cache/text/
#   …读 cache/text/<id>.txt 写 notes/<id>-<slug>.md（长文档抽样读）…
node tools/link-notes.mjs              # 校验卡片 + 回填 catalog
node tools/build-index.mjs             # 重建 index/INDEX.md
node tools/obsidian-sync.mjs           # 补 aliases + fulltext + 刷新 首页.md
node tools/extract-materials.mjs       # （可选）搬运素材/范文
node tools/extract-vocab.mjs           # （可选）搬运英语词条
node tools/make-review-cards.mjs       # ⚠️只增不改：补复习卡
node tools/status.mjs                  # 例行看板（一条命令）
```

**命令裸跑**：不要管道或重定向（沙箱拦截；`> $null` 会让命令**根本不执行**）。
深度体检（改完必跑）：`obsidian-check.mjs`、`check-yaml.mjs --all`、`check-math.mjs --quiet`。

## 6. 检索

`node tools/search.mjs <关键词>` → 读命中卡片 → 需精确内容读 `cache/text/<id>.txt` → 仍不足回原件核验 → 回答给出原件路径（含行号/页码）。**找不到就说"知识库中没有"，不要用常识补足。**

## 7. 写入与批量

- 改写产物放 `digests/`，命名 `<原id>-<用途>-v1.md`；就地改前先备份到 `digests/backup/`。
- 新增登记源：改 `tools/sources.json` 再跑 `scan.mjs`，不要手写 catalog。
- 批量 >10 篇用子代理并行，每批 5~8 篇（按字数均衡）；**子代理只写 `notes/`**，`index/` 与派生层由主控统一跑。
- 隐私：姓名、手机号、住址、成绩排名、收支明细在卡片与 quotes 中**必须脱敏**（`130****4667`）；严禁发往任何外部服务。
