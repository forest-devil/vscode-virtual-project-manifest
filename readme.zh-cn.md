# 子项目聚焦 (Sub Project Focus)

[English](readme.md)

基于 `MANIFEST.lst` 清单文件的虚拟子项目管理。旨在解决大项目中多个子项目并存时的开发干扰问题，并为 LLM（如 ChatGPT, Claude）提供一键式、有序的代码合并功能。

## 功能

- **子项目视图**：通过 `MANIFEST.lst` 定义子项目列表，在视图中只显示相关文件，点击时，同步激活主文件树的对应条目。
- **多项目工作区**： 支持一个工作区内维护多组子项目。只需在包含该清单文件的目录（或子目录）刷新视图即可。
- **代码/文档合并**：严格按照清单里的先后顺序，将代码合并为一个标准的`.md`文件（`MANIFEST.merged.md`），方便 AI 阅读。

## 清单语法 (`MANIFEST.lst`)

在你的子项目根目录下创建一个名为 `MANIFEST.lst` 的文件，使用以下语法：
**注意**
1. 路径相对于工作区根目录
2. 目录应以 `/**` 或 `/**/*` 结尾
3. `[var]`组的文件只会显示在导航栏中，不会参与代码合并

```ini
# [Sub Project Name]
# --------------------------
# [标签] 具有继承性，直到遇到下一个 [标签] 为止。
# 提示：对于目录，应使用 /** 或 /**/* 结尾以确保在虚拟视图中显示完整层级。

[doc] # 项目文档及指南
README.md
docs/your-project/**/*.md

[src] # 核心源代码
src/**/*.py
src/**/*.js
assets/js/your-main-script.js

[var] # 动态数据/静态资源 (仅在左侧视图显示，不参与代码合并)
data/your-project/**
assets/css/your-project/**

# --------------------------
# 提示：MANIFEST.lst 和 MANIFEST.merged.md 会自动显示并从合并中排除。
```
