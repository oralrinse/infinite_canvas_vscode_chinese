// AIManager.js - Handles all AI-related functionality for VS Code extension
import { getProviderName, getErrorMessage, generateAIIdeasGroq } from './aiService.js';

export class AIManager {
    constructor(canvasState, uiManager) {
        this.canvasState = canvasState;
        this.uiManager = uiManager;
        
        // AI configuration - using OpenRouter
        this.demoMode = false; // API key required for AI functionality
        
        // Read models from UI panel's localStorage - single source of truth
        this.aiModels = this.getModelsFromUIPanel();
        this.activeModels = JSON.parse(localStorage.getItem('ai_active_models') || '{}');
        
        console.log('🔧 AIManager using models from UI panel:', this.aiModels);
        console.log('🔧 Active models configuration:', this.activeModels);
        
        // Ensure all models from UI panel are active by default if not configured
        if (this.aiModels) {
            const modelArray = this.aiModels.split(',').map(m => m.trim());
            modelArray.forEach(model => {
                if (!(model in this.activeModels)) {
                    this.activeModels[model] = true;
                }
            });
        }
        
        console.log('🤖 AIManager initialized for VS Code with OpenRouter models:', this.activeModels);
    }
    
    // AI text generation - simplified for VS Code
    async generateAI() {
        if (this.canvasState.selectedNodes.length === 0) {
            if (this.uiManager && this.uiManager.showNotification) {
                this.uiManager.showNotification('请先选择一个节点，以便生成关联想法', 'warning');
            } else {
                console.warn('Please select a node first to generate connected ideas');
            }
            return;
        }

        if (this.canvasState.selectedNodes.length > 1) {
            if (this.uiManager && this.uiManager.showNotification) {
                this.uiManager.showNotification('请仅选择一个节点来生成想法，AI 生成仅支持单个节点。', 'warning');
            } else {
                console.warn('Please select only one node to generate ideas');
            }
            return;
        }

        const sourceNode = this.canvasState.selectedNodes[0];

        // Check if node has valid content - either text, file, or fullPath
        const hasText = sourceNode.text && typeof sourceNode.text === 'string';
        const hasFile = sourceNode.file && typeof sourceNode.file === 'string';
        const hasFullPath = sourceNode.fullPath && typeof sourceNode.fullPath === 'string';
        const isFileNode = sourceNode.type === 'file';
        
        if (!hasText && !hasFile && !hasFullPath && !isFileNode) {
            if (this.uiManager && this.uiManager.showNotification) {
                this.uiManager.showNotification('所选节点没有可用于生成想法的内容', 'warning');
            } else {
                console.warn('Selected node has no content');
            }
            return;
        }

        // For file nodes, we'll use the file content instead of text
        if (isFileNode || hasFile || hasFullPath) {
            console.log('📄 Processing file node for AI generation');
        }

        if (sourceNode.isGeneratingAI) {
            if (this.uiManager && this.uiManager.showNotification) {
                this.uiManager.showNotification('该节点的 AI 生成正在进行中...', 'info');
            } else {
                console.info('AI generation already in progress for this node...');
            }
            return;
        }

        try {
            sourceNode.isGeneratingAI = true;
            // Update button state immediately to show loading
            if (this.uiManager && this.uiManager.updateFloatingButton) {
                this.uiManager.updateFloatingButton();
            }
            console.log('🎯 Generating ideas for:', sourceNode.text);

            // Check if this is a markdown file and get its content
            let fileContent = null;
            let nodeText = sourceNode.text || sourceNode.file || sourceNode.fullPath || 'file content';
            
            const isMarkdownFile = this.isMarkdownFile(sourceNode);
            
            if (isMarkdownFile || isFileNode) {
                console.log('📄 Detected markdown/file node, requesting content...');
                fileContent = await this.getFileContent(sourceNode);
                
                // If we successfully got file content, use it as the main text
                if (fileContent && fileContent.trim().length > 0) {
                    nodeText = fileContent;
                    console.log('✅ Using file content as primary text for AI analysis');
                    // Set fileContent to null since we're using it as main content
                    fileContent = null;
                } else {
                    // Fallback to filename if no content retrieved
                    if (!sourceNode.text && (sourceNode.file || sourceNode.fullPath)) {
                        nodeText = sourceNode.file || sourceNode.fullPath.split('/').pop() || 'file content';
                    }
                    console.log('⚠️ No file content retrieved, using filename as fallback');
                }
            }

            const ancestorNodes = await this.getAncestorNodesWithContent(sourceNode);
            // Refresh models from UI panel each time to ensure sync
            this.aiModels = this.getModelsFromUIPanel();
            console.log('🔄 Refreshed models from UI panel:', this.aiModels);
            
            const allModels = this.aiModels.split(',').map(m => m.trim()).filter(m => m.length > 0);
            const models = allModels.filter(model => this.activeModels[model] !== false);

            console.log('📊 All available models:', allModels);
            console.log('✅ Active models for generation:', models);

            if (models.length === 0) {
                console.warn('❌ No active models found for generation');
                if (this.uiManager && this.uiManager.showNotification) {
                    this.uiManager.showNotification('未选择任何活跃模型，请先配置 AI 模型。', 'warning');
                } else {
                    console.warn('No active models selected');
                }
                return;
            }

            console.log(`🚀 Starting AI generation with ${models.length} model(s):`, models);

            let completedModels = 0;
            let totalNodes = 0;
            const createdNodes = [];

            const onModelComplete = async (modelResult) => {
                completedModels++;

                const sourceStillExists = this.canvasState.nodes.find(n => n.id === sourceNode.id);
                if (!sourceStillExists) {
                    console.warn('⚠️ Source node was deleted during generation, skipping node creation');
                    return;
                }

                if (modelResult.success && modelResult.ideas && modelResult.ideas.length > 0) {
                    modelResult.ideas.forEach((idea) => {
                        const childSpacing = 500;
                        const verticalOffset = 150;
                        const globalIndex = totalNodes;

                        const x = sourceNode.x + (sourceNode.width / 2) - 200 + (globalIndex * childSpacing);
                        const y = sourceNode.y + sourceNode.height + verticalOffset;

                        const newNode = this.canvasState.createNode(idea, x, y);
                        // Add model attribution
                        newNode.aiModel = modelResult.model;
                        createdNodes.push(newNode);

                        this.canvasState.createConnection(sourceNode, newNode);
                        totalNodes++;
                    });

                    this.canvasState.saveToLocalStorage();

                    const modelName = modelResult.model.split('/').pop() || modelResult.model;
                    console.log(`✅ ${modelName} generated ${modelResult.ideas.length} idea(s)`);
                } else if (!modelResult.success) {
                    const modelName = modelResult.model.split('/').pop() || modelResult.model;
                    console.error(`❌ ${modelName} failed: ${modelResult.errorMessage}`);
                }
            };

            const modelResults = await this.generateAIIdeasMultipleModelsOpenRouter(
                nodeText,
                ancestorNodes,
                models,
                onModelComplete,
                fileContent
            );

            const successfulModels = modelResults.filter(r => r.success).length;
            const failedModels = modelResults.filter(r => !r.success).length;

            let summaryMessage;
            if (totalNodes > 0) {
                summaryMessage = `🎉 Generation complete! Created ${totalNodes} idea(s) from ${successfulModels} model(s)`;
                if (failedModels > 0) {
                    summaryMessage += ` (${failedModels} model(s) failed)`;
                }
                if (isMarkdownFile) {
                    summaryMessage += ' (analyzed markdown content)';
                }
            } else {
                summaryMessage = `❌ No ideas generated. All ${models.length} model(s) failed.`;
            }

            console.log(summaryMessage);
            if (this.uiManager && this.uiManager.showNotification) {
                this.uiManager.showNotification(summaryMessage, totalNodes > 0 ? 'success' : 'error', 4000);
            }

        } catch (error) {
            console.error('Error calling AI API:', error);
            const errorMessage = getErrorMessage(error);
            if (this.uiManager && this.uiManager.showNotification) {
                this.uiManager.showNotification(errorMessage, 'error');
            } else {
                console.error(errorMessage);
            }
        } finally {
            sourceNode.isGeneratingAI = false;
            // Update floating button state after AI generation completes
            if (this.uiManager && this.uiManager.updateFloatingButton) {
                this.uiManager.updateFloatingButton();
            }
        }
    }

    // Helper method to detect if node represents a file that can be loaded
    isMarkdownFile(node) {
        // Check if it's a file node
        if (node.type === 'file') {
            return true; // Assume file nodes should be processed for content
        }
        
        // Check various node properties for file indicators
        const textToCheck = node.text || node.file || node.fullPath || '';
        
        if (!textToCheck || typeof textToCheck !== 'string') {
            return false;
        }
        
        // Check if the text looks like a file path with common extensions
        const trimmed = textToCheck.trim();
        const commonExtensions = ['.md', '.txt', '.json', '.js', '.ts', '.html', '.css', '.py', '.java', '.cpp', '.c'];
        
        // Check for any common file extension
        const hasFileExtension = commonExtensions.some(ext => 
            trimmed.endsWith(ext) || trimmed.includes(ext + ' ')
        );
        
        // Also check if it looks like a file path (contains / or \)
        const looksLikeFilePath = (trimmed.includes('/') || trimmed.includes('\\')) && 
                                 (trimmed.includes('.') || trimmed.toLowerCase().includes('file'));
        
        return hasFileExtension || looksLikeFilePath ||
               trimmed.toLowerCase().includes('markdown') ||
               trimmed.toLowerCase().includes('clippings');
    }

    // Helper method to get file content from VS Code
    async getFileContent(sourceNode) {
        return new Promise((resolve) => {
            if (!window.vsCodeAPI) {
                console.warn('❌ VS Code API not available');
                resolve(null);
                return;
            }

            // Determine the file path to use
            let filePath = sourceNode.text;
            
            // If this is a file node with a fullPath, use that instead
            if (sourceNode.fullPath) {
                filePath = sourceNode.fullPath;
                console.log('📁 Using full path for file node:', filePath);
            } else if (sourceNode.file) {
                filePath = sourceNode.file;
                console.log('📄 Using file property:', filePath);
            }

            // Check if the file node already has content loaded
            if (sourceNode.content && sourceNode.isContentLoaded) {
                console.log('✅ Using already loaded file content');
                resolve(sourceNode.content);
                return;
            }

            // Create a temporary node ID for this request
            const tempNodeId = 'temp_ai_request_' + Date.now();
            
            // Set up listener for the response using the correct message type
            const messageHandler = (event) => {
                const message = event.data;
                if (message.type === 'fileContentLoaded' && message.nodeId === tempNodeId) {
                    window.removeEventListener('message', messageHandler);
                    if (message.content && typeof message.content === 'string') {
                        console.log('✅ Received file content:', message.content.substring(0, 100) + '...');
                        resolve(message.content);
                    } else {
                        console.warn('❌ No content in file response');
                        resolve(null);
                    }
                } else if (message.type === 'fileContentError' && message.nodeId === tempNodeId) {
                    window.removeEventListener('message', messageHandler);
                    console.warn('❌ Failed to get file content:', message.error);
                    resolve(null);
                }
            };

            window.addEventListener('message', messageHandler);

            // Request file content using the working message type
            window.vsCodeAPI.postMessage({
                type: 'loadFile',
                filePath: filePath,
                nodeId: tempNodeId
            });

            // Timeout after 5 seconds
            setTimeout(() => {
                window.removeEventListener('message', messageHandler);
                console.warn('⏰ Timeout waiting for file content');
                resolve(null);
            }, 5000);
        });
    }
    
    // Helper method to get ancestor nodes (simplified)
    getAncestorNodes(node) {
        const ancestors = [];
        const visited = new Set();
        
        const findAncestors = (currentNode) => {
            if (visited.has(currentNode.id)) return;
            visited.add(currentNode.id);
            
            // Find connections where this node is the target
            const incomingConnections = this.canvasState.connections.filter(conn => conn.to === currentNode.id);
            
            incomingConnections.forEach(conn => {
                const parentNode = this.canvasState.nodes.find(n => n.id === conn.from);
                if (parentNode && !visited.has(parentNode.id)) {
                    ancestors.push(parentNode);
                    findAncestors(parentNode);
                }
            });
        };
        
        findAncestors(node);
        return ancestors;
    }
    
    // Enhanced method to get ancestor nodes with their content loaded
    async getAncestorNodesWithContent(node) {
        const ancestors = this.getAncestorNodes(node);
        console.log(`🔗 Found ${ancestors.length} ancestor nodes, loading content...`);
        
        // Load content for each ancestor node that represents a file
        for (const ancestor of ancestors) {
            const isFileNode = this.isMarkdownFile(ancestor) || ancestor.type === 'file';
            
            console.log(`🔍 Checking ancestor node:`, {
                id: ancestor.id,
                text: ancestor.text,
                file: ancestor.file,
                fullPath: ancestor.fullPath,
                type: ancestor.type,
                isFileNode: isFileNode,
                hasContent: !!ancestor.content,
                hasLoadedContent: !!ancestor.loadedContent
            });
            
            if (isFileNode && !ancestor.loadedContent) {
                console.log(`📄 Loading content for ancestor file node: ${ancestor.text || ancestor.file || ancestor.fullPath}`);
                try {
                    const content = await this.getFileContent(ancestor);
                    if (content && content.trim()) {
                        // Store the content in the ancestor node for the AI to use
                        ancestor.loadedContent = content;
                        console.log(`✅ Loaded ${content.length} characters for ancestor node`);
                    } else {
                        console.log(`⚠️ No content returned for ancestor file node`);
                    }
                } catch (error) {
                    console.warn(`⚠️ Failed to load content for ancestor node:`, error);
                }
            } else if (!isFileNode) {
                console.log(`📝 Ancestor is not a file node, using text content directly`);
            } else {
                console.log(`📋 Ancestor already has loaded content, using existing`);
            }
        }
        
        return ancestors;
    }
    
    // OpenRouter-based AI generation for multiple models
    async generateAIIdeasMultipleModelsOpenRouter(selectedNodeText, connectedNodes = [], models = [], onModelComplete = null, fileContent = null) {
        if (!models || models.length === 0) {
            throw new Error('No models specified');
        }

        const trimmedModels = models.map(m => m.trim()).filter(m => m.length > 0);

        if (trimmedModels.length === 0) {
            throw new Error('No valid models specified');
        }

        console.log(`🚀 Starting parallel OpenRouter generation with ${trimmedModels.length} models:`, trimmedModels);
        if (fileContent) {
            console.log('📄 Including markdown file content in generation');
        }

        // Create promises for all models to run in parallel
        const modelPromises = trimmedModels.map(async (model) => {
            try {
                console.log(`🤖 Starting OpenRouter generation with model: ${model}`);
                const ideas = await generateAIIdeasGroq(selectedNodeText, connectedNodes, model, fileContent);

                const result = {
                    model: model,
                    ideas: ideas,
                    success: true,
                    timestamp: Date.now()
                };

                // Call the callback immediately when this model completes
                if (onModelComplete && typeof onModelComplete === 'function') {
                    try {
                        await onModelComplete(result);
                    } catch (callbackError) {
                        console.error(`❌ Error in onModelComplete callback for ${model}:`, callbackError);
                    }
                }

                console.log(`✅ Completed OpenRouter generation with model: ${model}`);
                return result;
            } catch (error) {
                console.error(`❌ Error with OpenRouter model ${model}:`, error.message);

                const result = {
                    model: model,
                    ideas: [`OpenRouter error with ${model}: ${error.message}`],
                    success: false,
                    error: true,
                    errorMessage: error.message,
                    timestamp: Date.now()
                };

                // Call the callback even for errors
                if (onModelComplete && typeof onModelComplete === 'function') {
                    try {
                        await onModelComplete(result);
                    } catch (callbackError) {
                        console.error(`❌ Error in onModelComplete callback for ${model}:`, callbackError);
                    }
                }

                return result;
            }
        });

        // Wait for all models to complete (or fail)
        const results = await Promise.allSettled(modelPromises);

        // Extract the actual results from Promise.allSettled
        const finalResults = results.map(result => {
            if (result.status === 'fulfilled') {
                return result.value;
            } else {
                // This should rarely happen since we handle errors inside the promise
                console.error('❌ Unexpected promise rejection:', result.reason);
                return {
                    model: 'unknown',
                    ideas: [`Unexpected error: ${result.reason?.message || 'Unknown error'}`],
                    success: false,
                    error: true,
                    errorMessage: result.reason?.message || 'Unknown error',
                    timestamp: Date.now()
                };
            }
        });

        const successCount = finalResults.filter(r => r.success).length;
        const errorCount = finalResults.filter(r => !r.success).length;

        console.log(`🏁 Parallel OpenRouter generation completed: ${successCount} successful, ${errorCount} failed`);

        return finalResults;
    }
    
    // Configuration management (simplified for VS Code)
    getActiveModels() {
        return Object.keys(this.activeModels).filter(model => this.activeModels[model] !== false);
    }
    
    setActiveModels(activeModels) {
        this.activeModels = activeModels;
        localStorage.setItem('ai_active_models', JSON.stringify(activeModels));
        console.log('✅ AI model configuration updated:', activeModels);
    }
    
    // Get models from UI panel's localStorage - single source of truth
    getModelsFromUIPanel() {
        try {
            const storedModels = localStorage.getItem('aiModels');
            if (storedModels) {
                const modelsArray = JSON.parse(storedModels);
                console.log('📋 Found models in UI panel storage:', modelsArray);
                return modelsArray.join(',');
            } else {
                console.log('⚠️ No models found in UI panel storage, using fallback');
                // Fallback to default if nothing stored
                return 'google/gemini-2.5-flash,openai/gpt-oss-120b,openai/gpt-5,google/gemini-2.5-pro,x-ai/grok-4,qwen/qwen3-235b-a22b-thinking-2507,anthropic/claude-sonnet-4,tngtech/deepseek-r1t2-chimera:free';
            }
        } catch (error) {
            console.error('❌ Error reading models from UI panel:', error);
            return 'google/gemini-2.5-flash,openai/gpt-oss-120b,openai/gpt-5,google/gemini-2.5-pro,x-ai/grok-4,qwen/qwen3-235b-a22b-thinking-2507,anthropic/claude-sonnet-4,tngtech/deepseek-r1t2-chimera:free';
        }
    }

    getProviderName() {
        return 'OpenRouter';
    }
}