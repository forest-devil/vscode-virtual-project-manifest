# Virtual Project Manifest Manager (VPMM)

这是一个基于 `MANIFEST.lst` 清单文件的轻量级 VS Code 插件。它旨在解决大项目中多个子项目并存时的开发干扰问题，并为 LLM（如 ChatGPT, Claude）提供一键式、有序的代码合并功能。

## 核心特性

- 🎯 **项目聚焦 (Focus Mode)**：通过 `MANIFEST.lst` 定义“白名单”，瞬间隐藏无关文件，只留下当前任务需要的路径。
- 📦 **顺序合并 (Merge)**：严格按照清单里的行顺序，将代码合并为一个标准的 Markdown 文件，方便 AI 阅读和理解。
- 🔍 **自动溯源**：插件会自动从当前文件向上寻找 `MANIFEST.lst`，支持一个工作区内维护多组子项目。
- 🛠️ **原生体验**：直接操作原生文件树，完美兼容 VS Code 的所有内置功能。

## 清单语法 (`MANIFEST.lst`)

在你的子项目根目录下创建一个名为 `MANIFEST.lst` 的文件，使用以下语法：

```text
# 使用 '#' 号进行注释
# 默认行：既在文件树显示，也会参与合并
src/main.js
config/settings.json

# [doc] 或 [src] 标签：仅作为语义标注，同样参与合并
[doc] docs/architecture.md
[src] lib/core.ts

# [var] 标签：表示经常变动的文件，【不参与】代码合并，仅在文件树中显示
[var] tests/
[var] .env.example
[var] logs/*.log
