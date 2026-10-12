---
name: kb-longterm-ops
description: 个人知识库长线运营手册 —— 四类新内容的接入路径、随改动该跑哪几条命令、质量闸门、故障排查、指标看板与备份回滚。当一个已在运行的知识库要加新文件/新学科/新对话导出，或要跑例行体检、修断链/公式不渲染/YAML 报错/复习进度异常时使用。
whenToUse: 更新维护已有知识库（新增文件、补学科、导入对话导出、例行体检、修断链/公式/YAML/复习进度问题）。
---

# 知识库长线运营

> 假设库已是「原件 > 摘要卡 > 派生索引」三层结构（从零建库用 skill **`kb-starter`**）。
> 所有命令在库根执行；**不要给原生命令加管道或重定向**（受限沙箱会拦，且 `> $null` 会让命令**根本不执行**）。

## 0. 一分钟速查

| 你做了什么 | 跑这几条 |
| --- | --- |
| 磁盘上多了文件 | `scan` → `extract-text --all` → 写卡片 → `link-notes` → `build-index` → `obsidian-sync` → `obsidian-check` |
| 只想刷新索引/首页 | `link-notes` → `build-index` → `obsidian-sync` |
| 加了新词条 | `extract-vocab` → `make-review-cards`（⚠️**只增不改**） |
| 收了手工材料 | 存 `inbox/` → `scan --root=inbox` → 写卡 → 刷新索引 |
| 导入新对话导出 | `ds-chat-find --profile=<学科>` → `ds-chat-export --only=<ids>` → `scan --root=chats` → 子代理建卡 → 刷新 |
| 例行巡检（**首选一条命令**） | `status`（一屏看板：各层数量 + 状态分布 + 轻量质检） |
| 每周三件套 | `obsidian-check` + `check-yaml --all` + `check-math --quiet` |
| 改了卡片里的公式 | `render-math-body` → `check-math` |
| 导出 Word/Excel | `export-csv-docx`（CSV→Word）或 `lib-docx`（自组文档）→ `check-docx` 验收 |

## 1. 例行节奏

- **每次改动后**：`link-notes` → `build-index` → `obsidian-sync` → `obsidian-check`
- **每周**：`status` + `check-yaml --all` + `check-math --quiet`；顺手看库根有没有 0 字节空笔记
- **每月**：备份（§4）、抽检 10% 卡片能回溯到原件、记一次指标（见 `references/ops-detail.md` §6）

## 2. 质量闸门（合并前自查）

| 检查项 | 命令 | 通过标准 |
| --- | --- | --- |
| 卡片字段/标签/长度 | `link-notes` | "规范校验通过 ✓" |
| front matter 语法 | `check-yaml --all` | 0 问题 |
| 公式可渲染性 | `check-math` | 可修层 0 处 |
| 链接/同名/空笔记 | `obsidian-check` | "健康检查通过 ✓" |
| Word 成品 | `check-docx <file>` | "结构完好 ✓" |
| 复习层增量安全 | `make-review-cards` 输出 | "保留已有 M 张"，M 不减少 |

## 3. 三样东西**绝对不可覆盖**

1. **`notes/`**：手写卡片（人的劳动）
2. **`review/`**：复习进度 —— 插件把下次日期/间隔/难度以 HTML 注释写在**卡片行尾**，重写整文件 = 抹掉学习记录；只允许 `make-review-cards` 插入新行
3. **`inbox/`**：录入原件（照片笔记转录、粘贴内容、上传表格）

其余层（`cache/`、`fulltext/`、`materials/`、`vocab/`、`index/`）随时可重建。

## 4. 备份（按月）

- **必须备**：`notes/`、`review/`、`inbox/`、`index/tags.md`
- **建议备**：`index/catalog.jsonl`、`digests/`、`.obsidian/`（插件与设置）
- **不必备**（可重跑）：`cache/`、`fulltext/`、`materials/`、`vocab/`
- **回滚顺序**：先恢复 `notes/` 与 `review/` → `link-notes` → `build-index` → `obsidian-sync` → 体检
- ⚠️ `review/` 的进度**只在卡片行里，没有第二份**

## 5. 反模式

1. 用管道/重定向跑原生命令（可能静默不执行）
2. 整体重写 `review/` 或任何保存用户进度的文件
3. 把"渲染辅助小节"算进正文长度上限（会让数学卡假超限）
4. 让生成器清空整个派生目录（误删别的脚本产物）
5. 拿 `vocab/` `materials/` 这类可重建层当权威去反驳原件
6. 全量跑没经过小样验证的新解析器
7. 靠肉眼确认产物可用（必须先有验收器）

## 6. 深入（按需加载）

`references/ops-detail.md` 里有：四类新内容的**完整命令序列与验收点**、**故障排查表**（症状→原因→命令）、指标看板命令、扩展边界与工具约定、子代理批量规范。
