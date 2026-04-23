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
        'template': `# [Your Project Name]
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
        'template': `# [Your Project Name]
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

const DISPLAY_NAME = 'Sub Project Manager REMASTERED';
const NAMESPACE = 'sub-project-mgr';
const MANIFEST_FILE = 'MANIFEST.lst';
const MERGED_FILE = 'MANIFEST.merged.md';
const TREE_VIEW_ID = 'sub-project-explorer';

function t(key, ...args) {
    let s = (strings[lang] || strings['en'])[key] || key;
    args.forEach((v, i) => s = s.replace(`{${i}}`, v));
    return s;
}

function log(...args) {
    console.log(`[${DISPLAY_NAME}]`, ...args);
}

/** @type {ManifestTreeProvider} */
let globalProvider;

/** @type {Set<vscode.Uri>} */
let transientFiles = new Set();

/** @type {vscode.Uri} */
let matchedManifest = null;

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
            const newUri = vscode.Uri.joinPath(target.resourceUri, path.basename(uri.fsPath));
            if (uri.fsPath !== newUri.fsPath) edit.moveFile(uri, newUri);
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
        /** @type {vscode.Uri} */
        this.currentManifestUri = null;
    }
    refresh() { this._onDidChangeTreeData.fire(); }
    getTreeItem(element) { return element; }

    async getChildren(element) {
        if (!this.currentManifestUri) {
            const editor = vscode.window.activeTextEditor;
            this.currentManifestUri = await findManifestInParents(editor ? editor.document.uri : null);
        }
        if (!this.currentManifestUri) {
            const item = new vscode.TreeItem(t('not_found'));
            item.command = { command: `${NAMESPACE}.init`, title: '' };
            item.iconPath = new vscode.ThemeIcon('add');
            return [item];
        }

        const folder = vscode.workspace.getWorkspaceFolder(this.currentManifestUri);
        if (!folder) return [];

        if (!element) {
            const { viewPatterns } = await parseManifest(this.currentManifestUri);
            const treeData = {};
            const matchedPaths = new Set();
            const mergedUri = vscode.Uri.joinPath(this.currentManifestUri, '..', MERGED_FILE);
            let allUris = [this.currentManifestUri, mergedUri];

            for (const p of viewPatterns) {
                const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, p));
                found.forEach(f => {
                    allUris.push(f);
                    matchedPaths.add(vscode.workspace.asRelativePath(f, false).replace(/\\/g, '/'));
                });
            }
            transientFiles.forEach(uri => { 
                if (fs.existsSync(uri.fsPath)) allUris.push(uri);
            });

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
            return this.mapToItems(treeData, folder.uri.fsPath, matchedPaths);
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

            const itemUri = isFile ? currentData._uri : vscode.Uri.file(currentPath);
            const item = new ManifestItem(
                displayLabel,
                itemUri,
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

/**
 * 快速查找 Manifest 文件（仅向上搜索父目录）
 * @param {vscode.Uri} uri 
 * @returns {Promise<vscode.Uri | null>} Manifest URI or null
 */
async function findManifestInParents(uri) {
    if (path.basename(uri.fsPath) === MANIFEST_FILE) return uri;

    let dirUri = uri;
    if (uri.fsPath && fs.statSync(uri.fsPath).isFile()) {
        dirUri = vscode.Uri.joinPath(uri, '..');
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(dirUri);
    if (!workspaceFolder) return null;
    
    const root = workspaceFolder.uri.fsPath;
    let curr = dirUri.fsPath;
    
    while (root && curr.startsWith(root)) {
        const manifestPath = path.join(curr, MANIFEST_FILE);
        if (fs.existsSync(manifestPath)) return vscode.Uri.file(manifestPath);
        const parent = path.dirname(curr);
        if (parent === curr) break; // 到达根目录
        curr = parent;
    }
    return null;
}

/**
 * 查找所有 Manifest 文件
 * @param {vscode.Uri} uri 基准 URI（用于确定所属的工作区）
 * @returns {Promise<vscode.Uri[]>} Manifest URI 数组
 */
async function findAllManifests(uri) {
    const folder = uri ? vscode.workspace.getWorkspaceFolder(uri) : vscode.workspace.workspaceFolders?.[0];
    if (!folder) return [];

    const pattern = new vscode.RelativePattern(folder, `**/${MANIFEST_FILE}`); 
    return await vscode.workspace.findFiles(pattern);
}

/**
 * 解析 Manifest 文件
 * @param {vscode.Uri} uri 
 * @returns {Promise<{ viewPatterns: string[], mergeFiles: { tag: string, pattern: string }[] }>}
 */
async function parseManifest(uri) {
    const content = fs.readFileSync(uri.fsPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    let viewPatterns = [], mergeFiles = [], currentTag = "";
    lines.forEach(l => {
        const clean = l.split(/[#;].*$/)[0].trim();
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

/**
 * 检查文件是否在 Manifest 中
 * @param {vscode.Uri} fileUri 
 * @param {vscode.Uri} manifestUri 
 * @returns {Promise<boolean>}
 */
async function isFileInManifest(fileUri, manifestUri) {
    if (!manifestUri) return false;
    const { viewPatterns } = await parseManifest(manifestUri);
    const folder = vscode.workspace.getWorkspaceFolder(manifestUri);
    if (!folder) return false;

    for (const p of viewPatterns) {
        const pattern = new vscode.RelativePattern(folder, p); 
        const found = await vscode.workspace.findFiles(pattern);
        if (found.some(u => u.fsPath === fileUri.fsPath)) return true;
    }
    return false;
}

/**
 * 查找包含该文件的 Manifest 文件
 * @param {vscode.Uri} uri 
 * @returns {Promise<vscode.Uri | null>} 包含该文件的 Manifest URI 或 null
 */
async function findContainingManifest(uri) {
    const manifests = await findAllManifests(uri);
    for (const m of manifests) {
        if (await isFileInManifest(uri, m)) return m;
    }
    return null;
}

// 激活插件
let treeViewInstance;
async function activate(context) {
    log('Activated');
    const provider = new ManifestTreeProvider();
    globalProvider = provider;
    if (!treeViewInstance) {
        treeViewInstance = vscode.window.createTreeView(TREE_VIEW_ID, {
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

    const scan = async (uri) => {
        if (!uri) return;
        if (provider.currentManifestUri){
            matchedManifest = await findManifestInParents(uri);
        } else {
            matchedManifest = await findContainingManifest(uri);
        }
        if(matchedManifest && matchedManifest.fsPath !== provider.currentManifestUri?.fsPath){
            vscode.commands.executeCommand(`${NAMESPACE}.refresh`);
        }
    };

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(e => scan(e?.document.uri)),
        
        treeViewInstance.onDidChangeSelection(async (e) => {
            if (e.selection.length > 0) {
                const selectedItem = e.selection[0];
                await scan(selectedItem.resourceUri);
            }
        }),

        vscode.workspace.onDidCreateFiles(e => { e.files.forEach(u => transientFiles.add(u)); provider.refresh(); }),
        vscode.workspace.onDidRenameFiles(e => { e.files.forEach(m => { transientFiles.delete(m.oldUri); transientFiles.add(m.newUri); }); provider.refresh(); }),
        
        vscode.commands.registerCommand(`${NAMESPACE}.refresh`, () => {
            provider.currentManifestUri = matchedManifest;
            const workingUri = matchedManifest || vscode.window.activeTextEditor?.document.uri;
            const projectName = workingUri ? path.basename(path.dirname(workingUri.fsPath)) : '';
            treeViewInstance.description = projectName; 
            provider.refresh();
        }),

        vscode.commands.registerCommand(`${NAMESPACE}.init`, async () => {
            const editor = vscode.window.activeTextEditor;
            let targetUri;
            if (editor) {
                targetUri = vscode.Uri.joinPath(editor.document.uri, '..');
            } else if (matchedManifest) {
                targetUri = vscode.Uri.joinPath(matchedManifest, '..');
            } else {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) return;
                targetUri = workspaceFolder.uri;
            }
            const manifestUri = vscode.Uri.joinPath(targetUri, MANIFEST_FILE);
            if (!fs.existsSync(manifestUri.fsPath)) {
                fs.writeFileSync(manifestUri.fsPath, t('template'), 'utf-8');
            }
            provider.currentManifestUri = manifestUri;
            const doc = await vscode.workspace.openTextDocument(manifestUri);
            await vscode.window.showTextDocument(doc);
            provider.refresh();
        }),

        vscode.commands.registerCommand(`${NAMESPACE}.add`, async (item) => {
            const rel = vscode.workspace.asRelativePath(item.resourceUri, false).replace(/\\/g, '/');
            const mUri = await findManifestInParents(item.resourceUri);
            if (mUri) { fs.appendFileSync(mUri.fsPath, `\n${rel}`); transientFiles.delete(item.resourceUri); provider.refresh(); }
        }),

        vscode.commands.registerCommand(`${NAMESPACE}.merge`, async () => {
            if (!provider.currentManifestUri) return;
            const { mergeFiles } = await parseManifest(provider.currentManifestUri);
            const targetUri = vscode.Uri.joinPath(provider.currentManifestUri, '..', MERGED_FILE);
            let out = `# Merge Result\n\n`, seen = new Set();
            for (const f of mergeFiles) {
                const uris = await vscode.workspace.findFiles(f.pattern);
                for (const u of uris) {
                    if (u.fsPath === provider.currentManifestUri.fsPath || u.fsPath === targetUri.fsPath || seen.has(u.fsPath)) continue;
                    out += `## ${f.tag} ${vscode.workspace.asRelativePath(u, false)}\n\n\`\`\`\`\`\`${path.extname(u.fsPath).slice(1)}\n${fs.readFileSync(u.fsPath, 'utf-8')}\n\`\`\`\`\`\`\n\n`;
                    seen.add(u.fsPath);
                }
            }
            fs.writeFileSync(targetUri.fsPath, out);
            vscode.window.showTextDocument(await vscode.workspace.openTextDocument(targetUri));
        })
    );

    const currentUri = vscode.window.activeTextEditor?.document.uri;
    if (currentUri) {
        const manifestUri = await findContainingManifest(currentUri);
        log('Matched:', manifestUri?.fsPath);
        if (manifestUri) {
            matchedManifest = manifestUri;
            vscode.commands.executeCommand(`${NAMESPACE}.refresh`);
        }
    }
}

module.exports = { activate };