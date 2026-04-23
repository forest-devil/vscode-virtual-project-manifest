# Sub Project Manager REMASTERD

[中文](https://github.com/forest-devil/vscode-sub-project-mgr/blob/main/readme.zh-cn.md)

## **Sub-project Management Based on `MANIFEST.lst`**

This tool enables sub-project management via `MANIFEST.lst` manifest files. It is designed to eliminate development interference when multiple sub-projects coexist within a large repository and provides a "one-click," ordered code merging feature optimized for LLMs (such as ChatGPT and Claude).

## **Key Features**

* **Sub-project View**: List your sub-project files in a `MANIFEST.lst`. The `Sub Project` view in the left sidebar filters and displays only relevant files; clicking an item automatically navigate to the corresponding entry in the main file tree and highlights it.

* **Multi-project Workspace**: Maintain multiple sub-projects in one workspace. Simply refresh the `Sub Project` view in any directory (or subdirectory) containing a `MANIFEST.lst` file.

* **Code/Doc Merging**: Merges code into a standard Markdown file (`MANIFEST.merged.md`) following the exact sequence defined in the manifest, ensuring a seamless reading experience for AI models.

## **Manifest Syntax (`MANIFEST.lst`)**

Create a file named `MANIFEST.lst` in your sub-project root directory using the following syntax:

> **Important Notes:**
>
> 1. Paths must be relative to the **workspace root**.
>
> 2. Directories should end with `/**` or `/**/*`.
>
> 3. Files grouped under `[var]` will appear in the navigation bar for reference but will **not** be included in the merged result.

```ini
# [Your Project Name]
# --------------------------
# [Tag] labels are inherited until the next [Tag].
# Tip: Use /** or /**/* to ensure all items in directories are included.

[doc] # Documentation
README.md
docs/your-project/**/*.md   # the rest docs go here

[src] # Source Code
src/your-project/*.py
src/your-project/*.js
assets/js/your-project/main.js
assets/html/your-project/index.html

[var] # Static Assets (Tree only, excluded from Merge)
data/your-project/**
assets/css/your-project/style.css

# --------------------------
# HINT：MANIFEST.lst and MANIFEST.merged.md will be excluded from merge
```
