import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// 多语言（含文件模板）
const lang = vscode.env.language;
const strings = {
    'zh-cn': {
        'not_found': '未找到 MANIFEST.lst (点击初始化)',
        'unmatched': '⚠️ 未收录',
        'tooltip': '不在清单中，合并时将被忽略',
        'add_ok': '已添加 {0} 到清单',
        'untitled_project': '(未命名项目)',
        'select_project': '选择子项目',
        'switched': '已切换到: {0}',
    },
    'en': {
        'not_found': 'MANIFEST.lst not found (Click to Init)',
        'unmatched': '⚠️ untracked',
        'tooltip': 'Not in manifest, ignored during merge',
        'add_ok': 'Added {0} to manifest',
        'untitled_project': '(Untitled Project)',
        'select_project': 'Select Sub Project',
        'switched': 'Switched to: {0}',
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

function getTemplateUri(context){
    const fileName = lang === 'en' ? 'MANIFEST.template.lst' : `MANIFEST.template.${lang}.lst`;
    const fileUri = vscode.Uri.joinPath(context.extensionUri, 'resources', fileName);
    return fileUri;
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
            this.currentManifestUri = await getParentManifest();
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
 * @returns {Promise<vscode.Uri | null>} Manifest URI or null
 */
async function getParentManifest() {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || !doc.uri.fsPath) return null;
    if (path.basename(doc.uri.fsPath) === MANIFEST_FILE) return doc.uri;

    let dirUri = doc.uri;

    if (fs.statSync(doc.uri.fsPath).isFile()) {
        dirUri = vscode.Uri.joinPath(doc.uri, '..');
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
 * 查找包含该文件的 Manifest 文件
 * @returns {Promise<vscode.Uri | null>} 包含该文件的 Manifest URI 或 null
 */
async function getOwnerManifest() {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || !doc.uri.fsPath) return null;

    const manifests = await getAllManifests();
    for (const m of manifests) {    
        const folder = vscode.workspace.getWorkspaceFolder(m);
        const { viewPatterns } = await parseManifest(m);
        for (const p of viewPatterns) {
            const relPattern  = new vscode.RelativePattern(folder, p);
            const score = vscode.languages.match({
                pattern: relPattern
            }, doc);
            if(score > 0) return m
        }        
    }
    return null;
}

/**
 * 查找所有 Manifest 文件
 * @returns {Promise<vscode.Uri[]>} Manifest URI 数组
 */
async function getAllManifests() {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || !doc.uri.fsPath) return null;

    const folder = doc.uri ? vscode.workspace.getWorkspaceFolder(doc.uri) : vscode.workspace.workspaceFolders?.[0];
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
 * 读取 Manifest 首行，匹配模式: # [Project Name]
 * @param {vscode.uri} uri 
 * @returns 
 */
function getProjectName(uri) {
    const content = fs.readFileSync(uri.fsPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    if(lines.length < 1) return null;

    const match = lines[0].match(/^\s*# \[(.*?)\]\s*$/);
    if (match) {
        return match[1];
    } else {
        return null;
    }
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

    const scan = async () => {
        if (provider.currentManifestUri){
            matchedManifest = await getParentManifest();
        } else {
            matchedManifest = await getOwnerManifest();
        }
        if(matchedManifest && matchedManifest.fsPath !== provider.currentManifestUri?.fsPath){
            vscode.commands.executeCommand(`${NAMESPACE}.refresh`);
        }
    };

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(e => scan()),
        
        treeViewInstance.onDidChangeSelection(async (e) => {
            if (e.selection.length > 0) {
                const selectedItem = e.selection[0];
                await scan();
            }
        }),

        vscode.workspace.onDidCreateFiles(e => { e.files.forEach(u => transientFiles.add(u)); provider.refresh(); }),
        vscode.workspace.onDidRenameFiles(e => { e.files.forEach(m => { transientFiles.delete(m.oldUri); transientFiles.add(m.newUri); }); provider.refresh(); }),
        
        vscode.commands.registerCommand(`${NAMESPACE}.refresh`, () => {
            provider.currentManifestUri = matchedManifest;
            const workingUri = matchedManifest || vscode.window.activeTextEditor?.document.uri;
            const projectFolder = workingUri ? path.basename(path.dirname(workingUri.fsPath)) : '';
            treeViewInstance.description = projectFolder; 
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
                const tUri = getTemplateUri(context);
                const data = await vscode.workspace.fs.readFile(tUri);
                await vscode.workspace.fs.writeFile(manifestUri, data);
            }
            provider.currentManifestUri = manifestUri;
            const doc = await vscode.workspace.openTextDocument(manifestUri);
            await vscode.window.showTextDocument(doc);
            provider.refresh();
        }),

        vscode.commands.registerCommand(`${NAMESPACE}.add`, async (item) => {
            if(!fs.statSync(item.resourceUri.fsPath).isFile()) return;
            vscode.commands.executeCommand('vscode.open', item.resourceUri);
            const rel = vscode.workspace.asRelativePath(item.resourceUri, false).replace(/\\/g, '/');
            const mUri = await getParentManifest();
            if (mUri) { 
                fs.appendFileSync(mUri.fsPath, `\n${rel}`);
                transientFiles.delete(item.resourceUri); 
                provider.refresh(); 
            }
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
                    out += `## ${f.tag} ${vscode.workspace.asRelativePath(u, false)}\n\n\`\`\`\`\`\`\`\`\`${path.extname(u.fsPath).slice(1)}\n${fs.readFileSync(u.fsPath, 'utf-8')}\n\`\`\`\`\`\`\`\`\`\n\n`;
                    seen.add(u.fsPath);
                }
            }
            fs.writeFileSync(targetUri.fsPath, out);
            vscode.window.showTextDocument(await vscode.workspace.openTextDocument(targetUri));
        }),

        vscode.commands.registerCommand(`${NAMESPACE}.selectProject`, async () => {
            const quickPick = vscode.window.createQuickPick();

            const manifests = await getAllManifests();
            quickPick.items = manifests.map(m => ({                
                label: getProjectName(m) || t('untitled_project'),
                resourceUri: m
            }));

            quickPick.placeholder = t('select_project');
            
            if (provider.currentManifestUri) {
                const currentItem = quickPick.items.find(i => String(i.resourceUri) === String(provider.currentManifestUri));
                if (currentItem) quickPick.activeItems = [currentItem];
            };

            quickPick.onDidAccept(() => {
                const selection = quickPick.selectedItems[0];
                if (selection) {
                    matchedManifest = selection.resourceUri;
                    vscode.commands.executeCommand(`${NAMESPACE}.refresh`);
                }
                quickPick.hide();
            });

            quickPick.onDidHide(() => {quickPick.dispose();});
            quickPick.show();
        }),
    );

    const mUri = await getOwnerManifest();
    if (mUri) {
        matchedManifest = mUri;
        vscode.commands.executeCommand(`${NAMESPACE}.refresh`);
    }
}

export { activate };