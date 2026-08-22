// AI Service Module for VS Code Extension
// Using OpenRouter for AI model access

export function getProviderName(baseURL) {
    return 'OpenRouter';
}

export function getErrorMessage(error) {
    let errorMessage = '生成 AI 想法失败。';

    // Check for specific error patterns
    const errorString = error.message || JSON.stringify(error) || '';

    if (errorString.includes('No auth credentials found') || errorString.includes('401')) {
        errorMessage += '身份验证失败，请检查你的 API 密钥配置。';
    } else if (errorString.includes('API key')) {
        errorMessage += 'API 密钥问题，请在扩展设置中核实你的 API 密钥。';
    } else if (errorString.includes('quota') || errorString.includes('insufficient_quota')) {
        errorMessage += 'API 配额已用尽，请检查你的账户限额。';
    } else if (errorString.includes('network') || errorString.includes('fetch')) {
        errorMessage += '网络错误，请重试。';
    } else if (errorString.includes('unauthorized')) {
        errorMessage += '未授权访问，请检查你的 API 密钥配置。';
    } else if (errorString.includes('429') || errorString.includes('rate limit')) {
        errorMessage += '请求过于频繁，请稍后重试。';
    } else if (errorString.includes('model') && errorString.includes('not found')) {
        errorMessage += '请求的模型不可用，正在使用备用模型。';
    } else {
        errorMessage += errorString || '未知错误。';
    }

    return errorMessage;
}

// ============================================================================
// OPENROUTER API FUNCTIONS
// ============================================================================

// OpenRouter API key - using environment variable
let OPENROUTER_API_KEY = null;

// Try to get API key from various sources
if (typeof window !== 'undefined' && window.vsCodeAPI) {
    // Try to get from VS Code environment
    try {
        window.vsCodeAPI.postMessage({
            type: 'getOpenRouterApiKey'
        });
    } catch (e) {
        console.log('Could not request OpenRouter API key from VS Code');
    }
}

// Handle message from VS Code extension with API key
if (typeof window !== 'undefined') {
    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'openRouterApiKey') {
            OPENROUTER_API_KEY = message.apiKey;
            console.log('🔑 Received OpenRouter API key from VS Code extension');
        }
    });
}

export async function generateAIIdeasGroq(selectedNodeText, connectedNodes = [], model = 'anthropic/claude-3.5-sonnet', fileContent = null) {
    console.log('🎯 Using configurable AI service');
    console.log('🤖 Model:', model);

    // Get configurable settings from localStorage
    const baseUrl = localStorage.getItem('ai-base-url') || 'https://openrouter.ai/api/v1';
    const apiKey = localStorage.getItem('ai-api-key') || OPENROUTER_API_KEY;
    
    console.log('🌐 Base URL:', baseUrl);

    // Check if API key is available
    if (!apiKey) {
        console.warn('❌ API key not available');
        throw new Error('请在扩展设置中配置你的 API 密钥以使用 AI 功能。');
    }

    // Construct messages array with connected nodes as conversation history
    let messages = [];

    if (connectedNodes && connectedNodes.length > 0) {
        // Debug: log the ancestor nodes structure
        console.log('🔍 Ancestor nodes debug:', connectedNodes.map(node => ({
            id: node.id,
            text: node.text,
            file: node.file,
            fullPath: node.fullPath,
            type: node.type,
            hasText: !!node.text,
            textLength: node.text ? node.text.length : 0
        })));
        
        // Add connected nodes as previous messages in the conversation
        connectedNodes.forEach(node => {
            // Enhanced logic to handle different node types
            let nodeContent = null;
            
            // Try to get content from different node properties
            // Priority: loadedContent > text > file > fullPath
            if (node.loadedContent && typeof node.loadedContent === 'string' && node.loadedContent.trim()) {
                // If we have loaded file content, use it with a description
                const fileName = node.text || node.file || node.fullPath || 'file';
                nodeContent = `File: ${fileName}\n\nContent:\n${node.loadedContent.trim()}`;
                console.log(`📄 Using loaded file content for ancestor (${node.loadedContent.length} chars)`);
            } else if (node.text && typeof node.text === 'string' && node.text.trim()) {
                nodeContent = node.text.trim();
            } else if (node.file && typeof node.file === 'string' && node.file.trim()) {
                nodeContent = node.file.trim();
            } else if (node.fullPath && typeof node.fullPath === 'string' && node.fullPath.trim()) {
                nodeContent = node.fullPath.trim();
            }
            
            if (nodeContent) {
                messages.push({ role: "user", content: nodeContent });
                console.log('📎 Added ancestor node content:', nodeContent.substring(0, 100) + '...');
            } else {
                console.log('⚠️ Skipping ancestor node - no valid content:', { id: node.id, text: node.text });
            }
        });
        console.log('📎 Using', connectedNodes.length, 'connected nodes as conversation history');
    }

    // Add the current selected node as the latest message
    // If we have file content, include it directly
    let content = selectedNodeText || 'Generate ideas';
    if (fileContent && fileContent.trim()) {
        content = `${selectedNodeText || 'Analyze file'}\n\nFile content:\n${fileContent}`;
        console.log('📄 Including file content with node text');
    }

    // Ensure we always have valid content
    if (!content || typeof content !== 'string' || !content.trim()) {
        content = 'Generate creative ideas';
    }

    messages.push({ role: "user", content: content });

    console.log('💬 Message history:', messages.map(m => (m.content || '').substring(0, 100) + ((m.content || '').length > 100 ? '...' : '')));

    try {
        // Use fetch API with configurable base URL
        const apiUrl = `${baseUrl}/chat/completions`;
        console.log('📡 Making request to:', apiUrl);
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://vscode-infinite-canvas.com',
                'X-Title': 'VS Code Infinite Canvas'
            },
            body: JSON.stringify({
                model: model,
                messages: messages,
                temperature: 0.7
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        const responseText = data.choices[0].message.content;
        console.log('✅ OpenRouter response:', responseText);

        // Return the AI response as a single idea (one node)
        const trimmedResponse = responseText.trim();

        if (!trimmedResponse) {
            throw new Error('OpenRouter generated empty response');
        }

        return [trimmedResponse]; // Always return as array with single item

    } catch (apiError) {
        console.error('❌ OpenRouter API Error:', apiError.message);
        throw apiError;
    }
}


// Set OpenRouter API key (called from VS Code extension)
export function setOpenRouterApiKey(apiKey) {
    OPENROUTER_API_KEY = apiKey;
    console.log('🔑 OpenRouter API key updated');
}

// Expose the function globally for UI access
if (typeof window !== 'undefined') {
    window.setOpenRouterApiKey = setOpenRouterApiKey;
}