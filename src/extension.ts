import * as vscode from 'vscode';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    console.log('Infinite Canvas extension is now active!');

    // Register the custom editor provider
    const provider = new CanvasEditorProvider(context.extensionUri);
    const registration = vscode.window.registerCustomEditorProvider(
        'infinite-canvas.canvasEditor',
        provider
    );

    // Register the new canvas command
    const newCanvasCommand = vscode.commands.registerCommand('infinite-canvas.newCanvas', async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('请先打开工作区以创建新画布');
            return;
        }

        const fileName = await vscode.window.showInputBox({
            prompt: '输入画布文件名',
            value: 'untitled.canvas',
            validateInput: (value) => {
                if (!value.endsWith('.canvas')) {
                    return '文件必须以 .canvas 扩展名结尾';
                }
                return null;
            }
        });

        if (fileName) {
            const filePath = vscode.Uri.joinPath(workspaceFolder.uri, fileName);
            // Create new files in Obsidian-compatible format
            const initialContent = JSON.stringify({
                nodes: [],
                edges: []
            }, null, 2);

            await vscode.workspace.fs.writeFile(filePath, Buffer.from(initialContent));
            await vscode.commands.executeCommand('vscode.open', filePath);
        }
    });

    context.subscriptions.push(registration, newCanvasCommand);
}

export function deactivate() {}

class CanvasEditorProvider implements vscode.CustomTextEditorProvider {
    private static readonly viewType = 'infinite-canvas.canvasEditor';
    private isSaving = false; // Track when we're saving to prevent reload loops

    constructor(private readonly extensionUri: vscode.Uri) {}

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        // Setup initial webview options
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'webview'),
                vscode.Uri.joinPath(this.extensionUri, 'webview', 'src'),
                vscode.Uri.joinPath(this.extensionUri, 'webview', 'public')
            ]
        };

        // Set the HTML content
        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

        // Handle updates from the webview
        webviewPanel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'save':
                        this.isSaving = true;
                        await this.saveDocument(document, message.content);
                        // Small delay to ensure save completes before allowing reloads
                        setTimeout(() => {
                            this.isSaving = false;
                        }, 200);
                        break;
                    case 'ready':
                        // Send initial document content to webview
                        webviewPanel.webview.postMessage({
                            type: 'loadContent',
                            content: document.getText()
                        });
                        break;
                    case 'loadFile':
                        await this.loadFileContent(webviewPanel, message.filePath, message.nodeId);
                        break;
                    case 'saveFile':
                        await this.saveFileContent(message.filePath, message.content, webviewPanel, message.nodeId);
                        break;
                    case 'createFile':
                        await this.createFile(message.filePath, message.content, webviewPanel);
                        break;
                    case 'getGroqApiKey':
                        // Send Groq API key to webview if available
                        const groqApiKey = await this.getGroqApiKey();
                        if (groqApiKey) {
                            webviewPanel.webview.postMessage({
                                type: 'groqApiKey',
                                apiKey: groqApiKey
                            });
                        }
                        break;
                }
            }
        );

        // Handle document changes (when file is changed externally)
        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === document.uri.toString()) {
                // Don't reload if we're currently saving (prevents save/reload loops)
                if (!this.isSaving) {
                    webviewPanel.webview.postMessage({
                        type: 'loadContent',
                        content: document.getText()
                    });
                } else {
                    console.log('Skipping reload during save operation');
                }
            }
        });

        // Clean up when webview is disposed
        webviewPanel.onDidDispose(() => {
            changeDocumentSubscription.dispose();
        });
    }

    private async saveDocument(document: vscode.TextDocument, content: string): Promise<void> {
        const edit = new vscode.WorkspaceEdit();
        
        // Replace the entire document content
        edit.replace(
            document.uri,
            new vscode.Range(0, 0, document.lineCount, 0),
            content
        );

        await vscode.workspace.applyEdit(edit);
    }

    private async loadFileContent(webviewPanel: vscode.WebviewPanel, filePath: string, nodeId: string): Promise<void> {
        try {
            console.log('Loading file content for:', filePath);
            
            let fileUri: vscode.Uri;
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            
            if (!workspaceFolder) {
                throw new Error('No workspace folder found');
            }

            // Convert old absolute-like paths to relative paths
            let normalizedPath = this.normalizeToRelativePath(filePath, workspaceFolder.uri.fsPath);
            console.log('Normalized path:', normalizedPath);
            
            // Always treat the path as relative to workspace
            fileUri = vscode.Uri.joinPath(workspaceFolder.uri, normalizedPath);
            
            // Check if file exists and read content
            const fileStats = await vscode.workspace.fs.stat(fileUri);
            const fileContent = await vscode.workspace.fs.readFile(fileUri);
            const content = Buffer.from(fileContent).toString('utf8');
            
            // Send content back to webview
            webviewPanel.webview.postMessage({
                type: 'fileContentLoaded',
                nodeId: nodeId,
                content: content,
                lastModified: fileStats.mtime
            });
            
        } catch (error) {
            console.error('Error loading file content:', error);
            
            // Send error back to webview
            webviewPanel.webview.postMessage({
                type: 'fileContentError',
                nodeId: nodeId,
                error: `加载文件失败：${filePath}`
            });
        }
    }

    private normalizeToRelativePath(filePath: string, workspacePath: string): string {
        // If it's already a simple relative path, return as-is
        if (!filePath.includes('/') || (!filePath.startsWith('/') && !filePath.startsWith('Users'))) {
            return filePath;
        }
        
        // Handle paths that start with 'Users' (absolute paths with leading slash removed)
        if (filePath.startsWith('Users')) {
            const fullPath = '/' + filePath;
            
            // If the path starts with our workspace path, make it relative
            if (fullPath.startsWith(workspacePath)) {
                const relativePath = fullPath.substring(workspacePath.length + 1);
                console.log('Converted stored absolute path to relative:', filePath, '->', relativePath);
                return relativePath;
            }
        }
        
        // If it's an absolute path
        if (filePath.startsWith('/')) {
            // If the path starts with our workspace path, make it relative
            if (filePath.startsWith(workspacePath)) {
                const relativePath = filePath.substring(workspacePath.length + 1);
                console.log('Converted absolute path to relative:', filePath, '->', relativePath);
                return relativePath;
            }
        }
        
        // Fallback: return as-is
        return filePath;
    }
    
    private async saveFileContent(filePath: string, content: string, webviewPanel: vscode.WebviewPanel, nodeId: string): Promise<void> {
        try {
            console.log('Saving file content for:', filePath);
            
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                throw new Error('No workspace folder found');
            }
            
            // Normalize the path to be relative
            const normalizedPath = this.normalizeToRelativePath(filePath, workspaceFolder.uri.fsPath);
            console.log('Normalized save path:', normalizedPath);
            
            const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, normalizedPath);
            
            // Write content to file
            const fileContent = Buffer.from(content, 'utf8');
            await vscode.workspace.fs.writeFile(fileUri, fileContent);
            
            // Get updated file stats
            const fileStats = await vscode.workspace.fs.stat(fileUri);
            
            // Send success response back to webview
            webviewPanel.webview.postMessage({
                type: 'fileContentSaved',
                nodeId: nodeId,
                lastModified: fileStats.mtime
            });
            
        } catch (error) {
            console.error('Error saving file content:', error);
            
            // Send error back to webview
            webviewPanel.webview.postMessage({
                type: 'fileContentError',
                nodeId: nodeId,
                error: `保存文件失败：${filePath}`
            });
        }
    }
    
    private async createFile(filePath: string, content: string, webviewPanel: vscode.WebviewPanel): Promise<void> {
        try {
            console.log('Creating new file:', filePath);
            
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                throw new Error('No workspace folder found');
            }
            
            // Normalize the path to be relative
            const normalizedPath = this.normalizeToRelativePath(filePath, workspaceFolder.uri.fsPath);
            console.log('Normalized create path:', normalizedPath);
            
            const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, normalizedPath);
            
            // Create directories if they don't exist
            const dirUri = vscode.Uri.joinPath(fileUri, '..');
            try {
                await vscode.workspace.fs.stat(dirUri);
            } catch {
                // Directory doesn't exist, create it
                await vscode.workspace.fs.createDirectory(dirUri);
            }
            
            // Write content to file
            const fileContent = Buffer.from(content, 'utf8');
            await vscode.workspace.fs.writeFile(fileUri, fileContent);
            
            console.log('✅ File created successfully:', normalizedPath);
            
        } catch (error) {
            console.error('Error creating file:', error);
            vscode.window.showErrorMessage(`创建文件失败：${filePath}`);
        }
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        // Get URIs for webview resources
        const webviewUri = vscode.Uri.joinPath(this.extensionUri, 'webview');
        const mainScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewUri, 'main.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewUri, 'style.css'));
        
        // Get nonce for security
        const nonce = this.getNonce();

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'unsafe-inline'; connect-src https:; img-src ${webview.cspSource} https: data:;">
    <link href="${styleUri}" rel="stylesheet">
    <title>无限画布</title>
    
    <style>
        body {
            margin: 0;
            padding: 0;
            height: 100vh;
            overflow: hidden;
            background: #1e1e1e;
        }
        
        #canvas-container {
            width: 100%;
            height: 100%;
            position: relative;
        }
        
        canvas {
            display: block;
            cursor: grab;
            background: #1e1e1e;
        }
        
        canvas:active {
            cursor: grabbing;
        }
    </style>
</head>
<body>
    <div id="canvas-container">
        <canvas id="canvas"></canvas>
    </div>
    
    <script nonce="${nonce}">
        // VS Code API bridge
        const vscode = acquireVsCodeApi();
        
        // Global state for VS Code integration
        window.vsCodeAPI = {
            postMessage: (message) => vscode.postMessage(message),
            setState: (state) => vscode.setState(state),
            getState: () => vscode.getState()
        };
        
        // Listen for messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'loadContent':
                    if (window.loadCanvasContent) {
                        window.loadCanvasContent(message.content);
                    }
                    break;
            }
        });
        
        // Signal that webview is ready
        vscode.postMessage({ type: 'ready' });
    </script>
    
    <script nonce="${nonce}" type="module" src="${mainScriptUri}"></script>
</body>
</html>`;
    }

    private async getGroqApiKey(): Promise<string | null> {
        try {
            // Try to get from VS Code configuration
            const config = vscode.workspace.getConfiguration('infinite-canvas');
            const configApiKey = config.get<string>('groqApiKey');
            
            if (configApiKey && configApiKey.trim()) {
                return configApiKey.trim();
            }
            
            // Try to get from environment variables
            const envApiKey = process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY;
            if (envApiKey && envApiKey.trim()) {
                return envApiKey.trim();
            }
            
            // No API key found
            return null;
        } catch (error) {
            console.error('Error getting Groq API key:', error);
            return null;
        }
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }
}