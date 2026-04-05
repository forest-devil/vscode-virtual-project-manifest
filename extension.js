const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

let isFocusMode = false;

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
            const found = await vscode.workspace.findFiles(
                new vscode.RelativePattern(vscode.workspace.workspaceFolders, pattern)
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

async function toggleFocusMode() {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) return;
    
    const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
    if (!folder) return;

    if (!isFocusMode) {
        const manifestPath = await findManifestFile(path.dirname(activeEditor.document.uri.fsPath));
        if (!manifestPath) {
            vscode.window.showWarningMessage("请先确保存在 MANIFEST.lst");
            return;
        }

        const { allPatterns } = await parseManifest(manifestPath);
        const whiteList = new Set(['MANIFEST.lst', 'MANIFEST.merged.md']);
        
        allPatterns.forEach(p => {
            const parts = p.replace(/\\/g, '/').split('/');
            let current = '';
            parts.forEach(part => {
                current = current ? `${current}/${part}` : part;
                const cleanPath = current.replace(/[\*\?].*$/, '').replace(/\/$/, '');
                if (cleanPath) whiteList.add(cleanPath);
            });
        });

        const rootPath = folder.uri.fsPath;
        const allItems = fs.readdirSync(rootPath);
        let excludeRules = {};
        allItems.forEach(item => {
            if (!whiteList.has(item)) excludeRules[item] = true;
        });

        // ✅ 修复报错：传入明确的 folder.uri
        await vscode.workspace.getConfiguration('files', folder.uri)
            .update('exclude', excludeRules, vscode.ConfigurationTarget.WorkspaceFolder);
        
        isFocusMode = true;
        vscode.window.setStatusBarMessage("🎯 Manifest Focus: ON", 5000);
    } else {
        await vscode.workspace.getConfiguration('files', folder.uri)
            .update('exclude', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
        isFocusMode = false;
        vscode.window.setStatusBarMessage("🌈 Manifest Focus: OFF", 5000);
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
