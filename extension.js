const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// --- 樹視圖數據結構 ---
class ManifestItem extends vscode.TreeItem {
    constructor(label, uri, collapsibleState, isFile = false) {
        super(label, collapsibleState);
        this.resourceUri = uri;
        if (isFile) {
            this.command = { 
                command: 'vscode.open', 
                title: 'Open File', 
                arguments: [uri] 
            };
            this.contextValue = 'file';
        }
    }
}

class ManifestTreeProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }

    refresh() { this._onDidChangeTreeData.fire(); }
    getTreeItem(element) { return element; }

    async getChildren(element) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return [];
        const workspaceRoot = workspaceFolder.uri.fsPath;

        if (!element) {
            const editor = vscode.window.activeTextEditor;
            const startDir = editor ? path.dirname(editor.document.uri.fsPath) : workspaceRoot;
            const manifestPath = await findManifestFile(startDir);
            
            if (!manifestPath) return [new vscode.TreeItem("未找到 MANIFEST.lst")];

            const manifestDir = path.dirname(manifestPath);
            const { viewPatterns } = await parseManifest(manifestPath);
            const treeData = {};

            // 1. 強制包含清單文件和合併結果文件
            const essentialFiles = [
                vscode.Uri.file(manifestPath),
                vscode.Uri.file(path.join(manifestDir, 'MANIFEST.merged.md'))
            ];

            // 2. 收集所有視圖模式（含 [var]）匹配的文件
            let allFiles = [...essentialFiles];
            for (const pattern of viewPatterns) {
                const found = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(workspaceFolder, pattern),
                    null // 忽略排除规则
                );
                allFiles.push(...found);
            }

            // 3. 構建樹結構（去重並從工作區根目錄開始計算）
            const seen = new Set();
            allFiles.forEach(f => {
                const fsPath = f.fsPath;
                if (seen.has(fsPath)) return;
                seen.add(fsPath);

                const rel = vscode.workspace.asRelativePath(f, false).replace(/\\/g, '/');
                const parts = rel.split('/');
                let curr = treeData;
                parts.forEach((part, i) => {
                    if (i === parts.length - 1) {
                        curr[part] = { _uri: f };
                    } else {
                        curr[part] = curr[part] || {};
                        curr = curr[part];
                    }
                });
            });

            return this.mapToItems(treeData, workspaceRoot);
        }
        return element.children || [];
    }

    mapToItems(obj, parentPath) {
        return Object.keys(obj).sort().map(key => {
            const fullPath = path.join(parentPath, key);
            if (obj[key]._uri) {
                return new ManifestItem(key, obj[key]._uri, vscode.TreeItemCollapsibleState.None, true);
            } else {
                const item = new ManifestItem(key, vscode.Uri.file(fullPath), vscode.TreeItemCollapsibleState.Expanded);
                item.children = this.mapToItems(obj[key], fullPath);
                return item;
            }
        });
    }
}

// --- 通用輔助邏輯 ---
async function findManifestFile(startPath) {
    let current = startPath;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(startPath));
    const root = folder ? folder.uri.fsPath : null;
    while (current && current.startsWith(root || "")) {
        const p = path.join(current, 'MANIFEST.lst');
        if (fs.existsSync(p)) return p;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return null;
}

async function parseManifest(manifestPath) {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    
    let viewPatterns = []; // 視圖用（全部）
    let mergeFiles = [];   // 合併用（排除 [var]）
    let currentTag = "";

    lines.forEach(line => {
        const clean = line.split('#')[0].trim();
        if (!clean) return;

        const tagMatch = clean.match(/^\[(.*?)\]/);
        let p = clean;
        if (tagMatch) {
            currentTag = `[${tagMatch[1]}]`;
            p = clean.replace(/^\[.*?\]\s*/, '').trim();
        }

        if (p) {
            viewPatterns.push(p);
            if (currentTag !== '[var]') {
                mergeFiles.push({ tag: currentTag, pattern: p });
            }
        }
    });
    return { viewPatterns, mergeFiles };
}

// --- 合併邏輯 ---
async function mergeByManifest() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const manifestPath = await findManifestFile(path.dirname(editor.document.uri.fsPath));
    if (!manifestPath) return;

    const manifestDir = path.dirname(manifestPath);
    const mergedFilePath = path.join(manifestDir, 'MANIFEST.merged.md');
    const { mergeFiles } = await parseManifest(manifestPath);
    
    let output = `# Project Merge: ${path.basename(manifestDir)}\n\n`;
    const processedPaths = new Set();

    for (const item of mergeFiles) {
        const found = await vscode.workspace.findFiles(item.pattern);
        for (const f of found) {
            // 排除清單、結果文件及重複文件
            if (f.fsPath === manifestPath || f.fsPath === mergedFilePath) continue;
            if (processedPaths.has(f.fsPath)) continue;

            const rel = vscode.workspace.asRelativePath(f, false);
            const code = fs.readFileSync(f.fsPath, 'utf-8');
            const lang = path.extname(f.fsPath).slice(1) || 'text';
            const tagPrefix = item.tag ? `${item.tag} ` : "";

            output += `## ${tagPrefix}File: ${rel}\n\n\`\`\`${lang}\n${code}${code.endsWith('\n') ? '' : '\n'}\`\`\`\n\n`;
            processedPaths.add(f.fsPath);
        }
    }
    
    fs.writeFileSync(mergedFilePath, output, 'utf-8');
    vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mergedFilePath));
}

function activate(context) {
    const provider = new ManifestTreeProvider();
    vscode.window.registerTreeDataProvider('manifest-explorer', provider);

    context.subscriptions.push(
        vscode.commands.registerCommand('virtual-project-manifest.refreshEntry', () => provider.refresh()),
        vscode.commands.registerCommand('virtual-project-manifest.mergeByManifest', mergeByManifest),
        // 監控清單文件保存，自動刷新視圖
        vscode.workspace.onDidSaveTextDocument(doc => {
            if (doc.fileName.endsWith('MANIFEST.lst')) provider.refresh();
        })
    );
}

module.exports = { activate, deactivate: () => {} };