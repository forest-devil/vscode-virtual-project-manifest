const vscode = require('vscode');
const fs = require('fs');
const path = require('path');


/**
 * 仅负责向上查找逻辑
 */
async function findManifestFile(startPath) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return null;
    
    // 找到当前路径所属的工作区根目录
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(startPath));
    if (!folder) return null;
    
    const workspaceRoot = folder.uri.fsPath;
    let currentDir = startPath;

    while (currentDir.startsWith(workspaceRoot)) {
        const manifestPath = path.join(currentDir, 'MANIFEST.lst');
        if (fs.existsSync(manifestPath)) return manifestPath;
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) break;
        currentDir = parentDir;
    }
    return null;
}

/**
 * 获取清单，如果没有则引导创建（带模板）
 */
async function getOrRequestManifest(startDir) {
    let manifestPath = await findManifestFile(startDir);
    if (manifestPath) return manifestPath;

    const choice = await vscode.window.showInformationMessage(
        '未找到 MANIFEST.lst，是否在当前目录创建？', '立即创建'
    );

    if (choice === '立即创建') {
        const newPath = path.join(startDir, 'MANIFEST.lst');
        const config = vscode.workspace.getConfiguration('virtual-project-manifest');
        const template = config.get('defaultTemplate') || ["# [Virtual Project Manifest]", "[src] src/**/*.js"];
        
        fs.writeFileSync(newPath, template.join('\n'), 'utf-8');
        const doc = await vscode.workspace.openTextDocument(newPath);
        await vscode.window.showTextDocument(doc);
        return newPath;
    }
    return null;
}

/**
 * 解析逻辑：提取标签并保持顺序
 */
async function parseManifest(manifestPath) {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    const lines = content.split(/\r?\n/);

    let mergeFiles = [];
    let allPatterns = [];
    let currentTag = ""; // ✨ 初始化状态：记住上一个标签

    for (let line of lines) {
        // 1. 提取注释前的内容并去除首尾空格
        const cleanLine = line.split('#')[0].trim();
        if (!cleanLine) continue;

        // 2. 检查当前行是否包含新标签 [xxx]
        const tagMatch = cleanLine.match(/^\[(.*?)\]/);
        let pattern = cleanLine;

        if (tagMatch) {
            currentTag = `[${tagMatch[1]}]`; // 更新当前状态，例如 "[src]"
            // 去掉路径开头的标签部分，例如 "[src] main.js" -> "main.js"
            pattern = cleanLine.replace(/^\[.*?\]\s*/, '');
        }

        // 3. 如果这一行只有标签没有路径（如单独一行 "[src]"），则跳过文件查找但保留状态
        if (!pattern) continue;

        allPatterns.push(pattern);

        // 4. 根据当前状态决定是否合并（如果是 [var] 则跳过合并）
        if (currentTag !== '[var]') {
            const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(manifestPath));
            const found = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, pattern)
            );
            
            found.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
            
            found.forEach(f => {
                if (!mergeFiles.some(item => item.file.fsPath === f.fsPath)) {
                    // 使用“继承”下来的 currentTag
                    mergeFiles.push({ tag: currentTag, file: f });
                }
            });
        }
    }
    return { mergeFiles, allPatterns };
}

/**
 * 命令实现
 */

let isFocusMode = false;
async function toggleFocusMode() {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        vscode.window.showErrorMessage('请先打开工程内的一个文件以定位清单');
        return;
    }

    const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
    if (!folder) return;

    if (!isFocusMode) {
        // --- 开启聚焦：深度白名单模式 ---
        const startDir = path.dirname(activeEditor.document.uri.fsPath);
        const manifestPath = await findManifestFile(startDir);
        
        if (!manifestPath) {
            vscode.window.showWarningMessage("当前目录下未找到 MANIFEST.lst");
            return;
        }

        const { allPatterns } = await parseManifest(manifestPath);
        
        // 1. 构造白名单 Set
        const whiteList = new Set(['MANIFEST.lst', 'MANIFEST.merged.md']);
        
        // 解析模式并提取所有层级的父目录
        allPatterns.forEach(p => {
            const cleanPattern = p.replace(/\\/g, '/');
            const parts = cleanPattern.split('/');
            let current = '';
            parts.forEach(part => {
                current = current ? `${current}/${part}` : part;
                // 去掉通配符，只保留纯路径/目录名
                const pathNode = current.replace(/[\*\?].*$/, '').replace(/\/$/, '');
                if (pathNode) whiteList.add(pathNode);
            });
        });

        let excludeRules = {};
        const rootPath = folder.uri.fsPath;

        // 2. 递归扫描函数 (白名单核心逻辑)
        function scanAndExclude(currentPath, relativePath = "") {
            if (!fs.existsSync(currentPath)) return;
            
            const items = fs.readdirSync(currentPath);
            items.forEach(item => {
                const itemRelative = relativePath ? `${relativePath}/${item}`.replace(/\\/g, '/') : item;
                const itemAbsolute = path.join(currentPath, item);
                
                // 如果这个项目（文件或文件夹）不在白名单里
                if (!whiteList.has(itemRelative)) {
                    // 检查是否命中了通配符模式 (例如 src/*.js)
                    const isMatchedByPattern = allPatterns.some(p => {
                        // 简单的 glob 匹配模拟：如果模式包含通配符且项目位于该目录下
                        const basePattern = p.split('*')[0].replace(/\/$/, '');
                        return itemRelative.startsWith(basePattern) && itemRelative.endsWith(path.extname(p));
                    });

                    if (!isMatchedByPattern) {
                        excludeRules[itemRelative] = true; // 真正排除
                        return; // 不再深挖已排除的文件夹
                    }
                }

                // 如果是文件夹且在白名单中，递归进去继续精细过滤
                if (fs.statSync(itemAbsolute).isDirectory()) {
                    scanAndExclude(itemAbsolute, itemRelative);
                }
            });
        }

        // 3. 执行深度扫描并更新配置
        try {
            scanAndExclude(rootPath);
            await vscode.workspace.getConfiguration('files', folder.uri)
                .update('exclude', excludeRules, vscode.ConfigurationTarget.WorkspaceFolder);
            
            isFocusMode = true;
            vscode.window.setStatusBarMessage("🎯 Project Focus: ON (Whitelist Mode)", 5000);
        } catch (err) {
            vscode.window.showErrorMessage("聚焦模式启动失败: " + err.message);
        }

    } else {
        // --- 关闭聚焦：恢复原生视图 ---
        await vscode.workspace.getConfiguration('files', folder.uri)
            .update('exclude', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
        
        isFocusMode = false;
        vscode.window.setStatusBarMessage("🌈 Project Focus: OFF", 5000);
    }
}

async function mergeByManifest() {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) return;
    const startDir = path.dirname(activeEditor.document.uri.fsPath);

    const manifestPath = await getOrRequestManifest(startDir);
    if (!manifestPath) return;

    const { mergeFiles } = await parseManifest(manifestPath);
    
    let mergedContent = `# Project Merge: ${path.basename(path.dirname(manifestPath))}\n\n`;
    mergeFiles.forEach(item => {
        const relativePath = vscode.workspace.asRelativePath(item.file);
        const content = fs.readFileSync(item.file.fsPath, 'utf-8');
        const lang = path.extname(item.file.fsPath).slice(1) || 'text';
        const tagPrefix = item.tag ? `${item.tag} ` : "";

        mergedContent += `## ${tagPrefix}File: ${relativePath}\n\n`;
        mergedContent += `\`\`\`\`${lang}\n${content}${content.endsWith('\n') ? '' : '\n'}\`\`\`\`\n\n`;
    });

    const outputPath = path.join(path.dirname(manifestPath), 'MANIFEST.merged.md');
    fs.writeFileSync(outputPath, mergedContent);
    const doc = await vscode.workspace.openTextDocument(outputPath);
    await vscode.window.showTextDocument(doc);
}


function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand('virtual-project-manifest.toggleFocusMode', toggleFocusMode),
        vscode.commands.registerCommand('virtual-project-manifest.mergeByManifest', mergeByManifest)
    );
}

module.exports = { activate, deactivate: () => {} };
