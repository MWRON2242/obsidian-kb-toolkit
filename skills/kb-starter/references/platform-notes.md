# 平台相关性标注（kb-starter）

> 本工具包在 **Windows + PowerShell + DSH 沙箱** 下开发。换平台时按下表取舍。

## 平台无关（任何系统都成立）

- 三层架构（原件 > 摘要卡 > 派生索引）、只登记路径不动原件
- 「搬运而非重写」原则；抽取产物逐字保留
- 抽取 0 字/乱码 → `needs-ocr`（用 CJK 占比判定乱码）
- **先小样再全量**；**先写验收器**；透明度 > 自动化（`conf` 分级 + `anchor` 行号 + 未收录清单）
- Obsidian 约束：文件名全库唯一、链接写完整文件名、front matter 与代码块里的公式不渲染、行内公式不能跨行、表格里 `|` 要转义
- 派生层可重建 / 用户资产不可覆盖（`notes/`、`review/`）
- 所有 `.mjs` 是**纯 Node 标准库**（无第三方依赖），Node ≥ 18 即可（用到 `fetch` 的脚本建议 Node ≥ 20）

## Windows 专属（换平台要删掉对应条目）

| 条目 | 说明 |
| --- | --- |
| 沙箱**禁止给原生程序接管道**（`\| Out-String`、`> $null` 报 Access is denied，且 `> $null` 会让命令不执行） | DSH 在 Windows 的沙箱行为；其他系统上正常 shell 管道可用 |
| **PowerShell 5.1 的 `Set-Content -Encoding UTF8` 写 BOM** 会毁 front matter | 只有 Windows PowerShell 5.1 有这个问题；pwsh 7 / bash 无 |
| 中文路径不要从控制台回显里重打（编码不一致导致 `Test-Path` 假失败） | Windows 控制台代码页问题；其他平台一般无 |
| `注册到Obsidian.cmd` / `link-obsidian-vault.mjs` 用注册表定位 Obsidian | 依赖 `%APPDATA%\obsidian\obsidian.json` |
| Word COM 自动化（`.doc/.docx` 的备用方案） | 仅 Windows；其他平台用纯 JS 抽取 |
| Windows OCR（`Windows.Data.Pdf` + `Windows.Media.Ocr`）作为无依赖 OCR 路线 | 仅 Windows |
| `install-obsidian-plugin.mjs` 的路径 `%APPDATA%` 逻辑 | 换平台要改配置目录 |

## DSH 专属（其他 agent 应用请忽略或改写）

- `whenToUse` 是 DSH 扩展字段；其他应用只读 `name` + `description`（**保留无害**）。
- skill 目录：DSH 为 `~/.dsh/skills/<name>/SKILL.md`，**写入该目录可能需要提权**。
- `AGENTS.md` 是 DSH 的工作目录指令文件，**进入该目录的会话会自动加载**（所以它必须短：目标 ≤1.2k tokens，细节放 README 与 skill）。
- 沙箱三档（read-only / workspace-write / danger-full-access）与 approval 策略是 DSH 概念；其他应用无此限制，第 1 节的管道坑可能不适用。
- 子代理并行建卡（每批 5~8 篇）在 DSH 用 `subagent`；其他应用换成对应机制。

## 移植检查清单（把本工具包搬到别的机器/应用时）

1. `node scripts/bootstrap.mjs --kb=<新路径>` 建骨架 → `verify-fresh.mjs` 应全 ✓
2. 删掉 `AGENTS.md` 里不适用的 Windows 条目（或整体替换为你的应用约定）
3. 检查各脚本里的路径假设：搜索 `D:\\`、`%APPDATA%`、`app.getPath`
4. `tools/sources.json` 里的原文目录改成该机器的实际路径
5. 首次跑 `scan.mjs` 应只登记、不报错；`status.mjs` 应输出一屏看板
