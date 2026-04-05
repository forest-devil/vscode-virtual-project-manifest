# Virtual Project Manifest Manager (VPMM)

这是一个基于 `MANIFEST.lst` 清单文件的轻量级 VS Code 插件。它旨在解决大项目中多个子项目并存时的开发干扰问题，并为 LLM（如 ChatGPT, Claude）提供一键式、有序的代码合并功能。

## 核心特性

- 🎯 **项目聚焦 (Focus Mode)**：通过 `MANIFEST.lst` 定义“白名单”，瞬间隐藏无关文件，只留下当前任务需要的路径。
- 📦 **顺序合并 (Merge)**：严格按照清单里的行顺序，将代码合并为一个标准的 Markdown 文件，方便 AI 阅读和理解。
- 🔍 **自动溯源**：插件会自动从当前文件向上寻找 `MANIFEST.lst`，支持一个工作区内维护多组子项目。


## 清单语法 (`MANIFEST.lst`)

在你的子项目根目录下创建一个名为 `MANIFEST.lst` 的文件，使用以下语法：

```text
# [Virtual Project Manifest]
# --------------------------
# [标签] 具有继承性，直到遇到下一个 [标签] 为止。
# 提示：对于目录，应使用 /** 结尾以确保在虚拟视图中显示完整层级。

[doc] # 项目文档及指南
README.md
docs/your-project/**/*.md

[src] # 核心源代码,
src/**/*.py
src/**/*.js
assets/js/your-main-script.js

[var] # 动态数据/静态资源 (仅在左侧视图显示，不参与代码合并)
data/your-project/**
data/temp/your-project/**
assets/css/your-project/**

# --------------------------
# 提示：MANIFEST.lst 和 MANIFEST.merged.md 会自动显示并从合并中排除。
