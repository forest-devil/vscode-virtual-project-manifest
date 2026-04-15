const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// 多语言（含文件模板）
const lang = vscode.env.language;
const strings = {
    'zh-cn': {
        'not_found': '未找到 MANIFEST.lst (点击初始化)',
        'unmatched': '⚠️ 未收录',
        'tooltip': '不在清单中，合并时将被忽略',
        'add_ok': '已添加 {0} 到清单',
        'switched': '已切换到项目: {0}',
        'template': `# [Virtual Project Manifest]
--------------------------
# [标签] 具有继承性，直到遇到下一个 [标签] 为止。
# 提示：对于目录，应使用 /** 或 /**/* 结尾以确保在虚拟视图中显示完整层级。

[doc] # 项目文档及指南
docs/your-project/README.md
docs/your-project/**/*.md   # 其他文档排在最后

[src] # 核心源代码
src/your-project/*.py
src/your-project/*.js
assets/js/your-project/main.js
assets/html/your-project/index.html

[var] # 动态数据/静态资源 (仅在左侧视图显示，不参与代码合并)
data/your-project/**
assets/css/your-project/style.css

# --------------------------
# 提示：MANIFEST.lst 和 MANIFEST.merged.md 会自动显示并从合并中排除。
`
    },
    'en': {
        'not_found': 'MANIFEST.lst not found (Click to Init)',
        'unmatched': '⚠️ untracked',
        'tooltip': 'Not in manifest, ignored during merge',
        'add_ok': 'Added {0} to manifest',
        'switched': 'Switched to: {0}',
        'template': `# [Virtual Project Manifest]
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
`
    }
};

function t(key, ...args) {
    let s = (strings[lang] || strings['en'])[key] || key;
    args.forEach((v, i) => s = s.replace(`{${i}}`, v));
    return s;
}

let globalProvider;
let transientFiles = new Set();
let lastScannedManifest = null;

// 树节点与 DND
class ManifestItem extends vscode.TreeItem {
    constructor(label, uri, collapsibleState, isFile = false) {
        super(label, collapsibleState);
        this.resourceUri = uri;
        this.contextValue = isFile ? 'file' : 'folder';
        if (isFile) this.command = { command: 'vscode.open', title: '', arguments: [uri] };
    }
}

class ManifestDnDController {
    async handleDrag(source, treeDataTransfer) {
        const uris = source.map(item => item.resourceUri.toString());
        treeDataTransfer.set('text/uri-list', new vscode.DataTransferItem(uris.join('\r\n')));
    }
    async handleDrop(target, treeDataTransfer) {
        if (!target || !['folder', 'unmatchedFolder'].includes(target.contextValue)) return;
        const transferItem = treeDataTransfer.get('text/uri-list');
        if (!transferItem) return;
        const uris = (await transferItem.asString()).split('\r\n').filter(u => u).map(u => vscode.Uri.parse(u));
        const edit = new vscode.WorkspaceEdit();
        for (const uri of uris) {
            const newP = path.join(target.resourceUri.fsPath, path.basename(uri.fsPath));
            if (uri.fsPath !== newP) edit.moveFile(uri, vscode.Uri.file(newP));
        }
        await vscode.workspace.applyEdit(edit);
        globalProvider.refresh();
    }
}

// 视图主类
class ManifestTreeProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.currentManifestPath = null;
    }
    refresh() { this._onDidChangeTreeData.fire(); }
    getTreeItem(element) { return element; }

    async getChildren(element) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return [];
        const root = folder.uri.fsPath;

        if (!element) {
            if (!this.currentManifestPath) {
                const editor = vscode.window.activeTextEditor;
                this.currentManifestPath = await findManifest(editor ? path.dirname(editor.document.uri.fsPath) : root);
            }
            if (!this.currentManifestPath || !fs.existsSync(this.currentManifestPath)) {
                const item = new vscode.TreeItem(t('not_found'));
                item.command = { command: 'virtual-project-manifest.init', title: '' };
                item.iconPath = new vscode.ThemeIcon('add');
                return [item];
            }

            const { viewPatterns } = await parseManifest(this.currentManifestPath);
            const treeData = {};
            const matchedPaths = new Set();
            let allUris = [vscode.Uri.file(this.currentManifestPath), vscode.Uri.file(path.join(path.dirname(this.currentManifestPath), 'MANIFEST.merged.md'))];

            for (const p of viewPatterns) {
                const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, p));
                found.forEach(f => {
                    allUris.push(f);
                    matchedPaths.add(vscode.workspace.asRelativePath(f, false).replace(/\\/g, '/'));
                });
            }
            transientFiles.forEach(fp => { if (fs.existsSync(fp)) allUris.push(vscode.Uri.file(fp)); });

            allUris.forEach(f => {
                const rel = vscode.workspace.asRelativePath(f, false).replace(/\\/g, '/');
                const isMatched = matchedPaths.has(rel);
                let curr = treeData;
                const parts = rel.split('/');
                parts.forEach((part, i) => {
                    if (isMatched) matchedPaths.add(parts.slice(0, i + 1).join('/')); // 路径回溯
                    if (i === parts.length - 1) curr[part] = { _uri: f, _rel: rel };
                    else { curr[part] = curr[part] || {}; curr = curr[part]; }
                });
            });
            return this.mapToItems(treeData, root, matchedPaths);
        }
        return element.children || [];
    }

    mapToItems(obj, parent, matched) {
        // --- 第一步：先遍历生成初步的 Item 数据（不直接 return） ---
        const itemsData = Object.keys(obj).map(key => {
            let currentEntry = obj[key];
            let currentKey = key;
            let currentPath = path.join(parent, key);
            let displayLabel = key;
            let description = '';

            // 拍平深层目录
            while (this.isFolder(currentEntry)) {
                const childrenKeys = Object.keys(currentEntry).filter(k => k !== '_uri' && k !== '_rel');
                if (childrenKeys.length === 1) {
                    const childKey = childrenKeys[0];
                    const childEntry = currentEntry[childKey];
                    if (this.isFolder(childEntry)) {
                        currentKey = path.join(currentKey, childKey).replace(/\\/g, '/');
                        currentPath = path.join(currentPath, childKey);
                        currentEntry = childEntry;
                        displayLabel = currentKey;
                    } else {
                        const relativeDir = path.relative(parent, currentPath).replace(/\\/g, '/');
                        currentEntry = childEntry;
                        currentKey = childKey;
                        currentPath = path.join(currentPath, childKey);
                        displayLabel = childKey;
                        description = relativeDir ? `(${relativeDir})` : '';
                        break;
                    }
                } else { break; }
            }

            const isFile = !!currentEntry._uri;
            return { currentData: currentEntry, currentPath, displayLabel, displayDescription: description, isFile };
        });

        // 排序
        itemsData.sort((a, b) => {
            // 文件夹优先（最终拍平后）
            if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;        
            // 再按 stem 排序
            return a.displayLabel.localeCompare(b.displayLabel, undefined, { numeric: true, sensitivity: 'base' });
        });

        // 构建 ManifestItem
        return itemsData.map(data => {
            const { currentData, currentPath, displayLabel, displayDescription, isFile } = data;
            
            // 递归处理子项获取数量
            let children = [];
            let collapsibleState = isFile ? 0 : 1;
            if (!isFile) {
                children = this.mapToItems(currentData, currentPath, matched);
                if (children.length > 0 && children.length < 10) collapsibleState = 2;
            }

            const item = new ManifestItem(
                displayLabel,
                isFile ? currentData._uri : vscode.Uri.file(currentPath),
                collapsibleState,
                isFile
            );

            // description + “未收录”状态
            const rel = currentData._rel || vscode.workspace.asRelativePath(currentPath, false).replace(/\\/g, '/');
            item.description = displayDescription;
            
            if (!matched.has(rel) && !rel.includes('MANIFEST.')) {
                const statusText = t('unmatched');
                item.description = item.description ? `${item.description} ${statusText}` : statusText;
                item.contextValue = isFile ? 'unmatchedFile' : 'unmatchedFolder';
                item.iconPath = new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.orange'));
            }

            if (!isFile) item.children = children;
            return item;
        });
    }

    isFolder = entry => entry && typeof entry === 'object' && !entry._uri;
    
}

// --- 4. 辅助逻辑 ---
async function findManifest(start) {
    const root = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(start))?.uri.fsPath;
    let curr = start;
    while (root && curr.startsWith(root)) {
        const p = path.join(curr, 'MANIFEST.lst');
        if (fs.existsSync(p)) return p;
        curr = path.dirname(curr);
    }
    return null;
}

async function parseManifest(mPath) {
    const lines = fs.readFileSync(mPath, 'utf-8').split(/\r?\n/);
    let viewPatterns = [], mergeFiles = [], currentTag = "";
    lines.forEach(l => {
        const clean = l.split('#')[0].trim();
        const tagM = clean.match(/^\[(.*?)\]/);
        let p = tagM ? clean.replace(/^\[.*?\]\s*/, '').trim() : clean;
        if (tagM) currentTag = `[${tagM[1]}]`;
        if (p) {
            viewPatterns.push(p);
            if (currentTag !== '[var]') mergeFiles.push({ tag: currentTag, pattern: p });
        }
    });
    return { viewPatterns, mergeFiles };
}

// --- 5. 激活插件 ---
let treeViewInstance;
function activate(context) {
    const provider = new ManifestTreeProvider();
    globalProvider = provider;
    if (!treeViewInstance) {
        treeViewInstance = vscode.window.createTreeView('manifest-explorer', {
            treeDataProvider: provider,
            dragAndDropController: new ManifestDnDController(),
            showCollapseAll: true,
            canSelectMany: true
        });
        
        // 将实例添加到订阅中，以便插件卸载时自动销毁
        context.subscriptions.push(treeViewInstance);
    } else {
        // 如果已经存在，只需要更新它的数据源即可
        treeViewInstance.reveal(undefined); // 可选：刷新一下位置
    }

    const scan = async (editor) => {
        if (!editor) return;
        lastScannedManifest = await findManifest(path.dirname(editor.document.uri.fsPath));
        if(lastScannedManifest && lastScannedManifest !== provider.currentManifestPath){
            vscode.commands.executeCommand('virtual-project-manifest.refresh');
        }
    };

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(e => scan(e)),

        vscode.workspace.onDidCreateFiles(e => { e.files.forEach(u => transientFiles.add(u.fsPath)); provider.refresh(); }),
        vscode.workspace.onDidRenameFiles(e => { e.files.forEach(m => { transientFiles.delete(m.oldUri.fsPath); transientFiles.add(m.newUri.fsPath); }); provider.refresh(); }),
        
        vscode.commands.registerCommand('virtual-project-manifest.refresh', () => {
            provider.currentManifestPath = lastScannedManifest;
            const workingPath = lastScannedManifest || vscode.window.activeTextEditor.document.uri.fsPath;
            const projectName = path.basename(path.dirname(workingPath));
            treeViewInstance.description = projectName; 
            provider.refresh();
        }),

        vscode.commands.registerCommand('virtual-project-manifest.init', async () => {
            const folder = vscode.workspace.workspaceFolders?.[0];
            const editor = vscode.window.activeTextEditor;
            const targetDir = editor ? path.dirname(editor.document.uri.fsPath) : folder?.uri.fsPath;
            if (!targetDir) return;
            const mPath = path.join(targetDir, 'MANIFEST.lst');
            if (!fs.existsSync(mPath)) fs.writeFileSync(mPath, t('template'), 'utf-8');
            provider.currentManifestPath = mPath;
            const doc = await vscode.workspace.openTextDocument(mPath);
            await vscode.window.showTextDocument(doc);
            provider.refresh();
        }),

        vscode.commands.registerCommand('virtual-project-manifest.add', async (item) => {
            const rel = vscode.workspace.asRelativePath(item.resourceUri, false).replace(/\\/g, '/');
            const mP = await findManifest(path.dirname(item.resourceUri.fsPath));
            if (mP) { fs.appendFileSync(mP, `\n${rel}`); transientFiles.delete(item.resourceUri.fsPath); provider.refresh(); }
        }),

        vscode.commands.registerCommand('virtual-project-manifest.merge', async () => {
            if (!provider.currentManifestPath) return;
            const { mergeFiles } = await parseManifest(provider.currentManifestPath);
            const target = path.join(path.dirname(provider.currentManifestPath), 'MANIFEST.merged.md');
            let out = `# Merge Result\n\n`, seen = new Set();
            for (const f of mergeFiles) {
                const uris = await vscode.workspace.findFiles(f.pattern);
                for (const u of uris) {
                    if (u.fsPath === provider.currentManifestPath || u.fsPath === target || seen.has(u.fsPath)) continue;
                    out += `## ${f.tag} ${vscode.workspace.asRelativePath(u, false)}\n\n\`\`\`\`\`\`${path.extname(u.fsPath).slice(1)}\n${fs.readFileSync(u.fsPath, 'utf-8')}\n\`\`\`\`\`\`\n\n`;
                    seen.add(u.fsPath);
                }
            }
            fs.writeFileSync(target, out);
            vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
        })
    );
    scan(vscode.window.activeTextEditor);
}

module.exports = { activate };