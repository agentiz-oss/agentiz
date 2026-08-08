import { z } from 'zod';
import {
    AbstractAiModelService,
    AiAgentConnectionStatus,
    AiAgentSessionMeta,
    AiAgentStreamEvent,
    AiAgentUiHints,
    User,
} from '@nodeknit/app-adminizer';
import type { AppManager } from '@nodeknit/app-manager';
import type { AppMCP } from '@nodeknit/app-mcp';

type StreamEvent = AiAgentStreamEvent;

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_TOOL_RESULT_CHARS = 64_000;
const MAX_TOOL_ARRAY_ITEMS = 50;
const MAX_TOOL_OBJECT_KEYS = 100;

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean; originalChars: number } {
    if (value.length <= maxChars) return { text: value, truncated: false, originalChars: value.length };
    return { text: `${value.slice(0, Math.max(0, maxChars - 1))}…`, truncated: true, originalChars: value.length };
}

/** Bounds an MCP tool result so a chatty tool cannot blow out the agent's context window. */
function clampForAgentPayload(value: unknown, maxDepth = 5): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return truncateText(value, MAX_TOOL_RESULT_CHARS).text;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (maxDepth <= 0) return '[truncated: max depth reached]';

    if (Array.isArray(value)) {
        const limited = value.slice(0, MAX_TOOL_ARRAY_ITEMS).map((entry) => clampForAgentPayload(entry, maxDepth - 1));
        if (value.length > MAX_TOOL_ARRAY_ITEMS) {
            limited.push(`[truncated: ${value.length - MAX_TOOL_ARRAY_ITEMS} more items]`);
        }
        return limited;
    }

    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>);
        const limitedEntries = entries.slice(0, MAX_TOOL_OBJECT_KEYS);
        const result: Record<string, unknown> = {};
        for (const [key, entry] of limitedEntries) result[key] = clampForAgentPayload(entry, maxDepth - 1);
        if (entries.length > MAX_TOOL_OBJECT_KEYS) {
            result.__truncated__ = `${entries.length - MAX_TOOL_OBJECT_KEYS} more keys omitted`;
        }
        return result;
    }

    return String(value);
}

function summarizeToolResult(toolName: string, result: unknown): Record<string, unknown> {
    const limited = clampForAgentPayload(result);
    const json = JSON.stringify(limited);
    if (json.length <= MAX_TOOL_RESULT_CHARS) {
        return { tool: toolName, result: limited };
    }
    const truncated = truncateText(json, MAX_TOOL_RESULT_CHARS);
    return {
        tool: toolName,
        result: { truncated: true, originalChars: truncated.originalChars, jsonPreview: truncated.text },
    };
}

/**
 * OpenHarness-backed admin assistant registered into Adminizer 5's built-in AI Assistant panel.
 * It does not implement its own domain tools: every capability comes from the `mcpTools`
 * collection (app-mcp), reached in-process through `list_mcp_tools`/`call_mcp_tool` — the same
 * bridge pattern restoapp's OpenHarness agent uses for its own MCP server. Credentials are plain
 * env vars (OPENHARNESS_API_KEY/_BASE_URL/_MODEL); there is no broker/auto-registration here.
 */
export class AgentizAssistantService extends AbstractAiModelService {
    private readonly sessions = new Map<number, any>();

    constructor(private readonly mcpApp: AppMCP, private readonly appManager: AppManager) {
        super({
            id: 'agentiz-assistant',
            name: 'Agentiz Assistant',
            description: 'Answers questions about Agentiz projects, tasks and pipeline runs using the registered MCP tools.',
        });
    }

    isEnabled(): boolean {
        return Boolean(process.env.OPENHARNESS_API_KEY);
    }

    getConnectionStatus(): AiAgentConnectionStatus {
        if (this.isEnabled()) {
            return { state: 'ready', provider: 'openai-compatible', baseUrl: this.getBaseUrl() };
        }
        return { state: 'setup_required', lastError: 'OPENHARNESS_API_KEY is not set.' };
    }

    getUiHints(): AiAgentUiHints {
        return {
            title: this.name,
            welcomeHint: 'Ask about Agentiz projects, tasks and pipeline runs.',
            composerPlaceholder: 'Ask Agentiz… type / for commands',
            suggestions: ['Give me an overview of Agentiz', 'List active projects', 'What MCP tools are available?'],
            setupSetting: 'OPENHARNESS_API_KEY',
            connectionScreens: {
                setup_required: {
                    title: 'Assistant not connected',
                    description: 'Set OPENHARNESS_API_KEY (and optionally OPENHARNESS_BASE_URL / OPENHARNESS_MODEL) in the environment to enable the assistant.',
                    icon: 'bot',
                },
            },
        };
    }

    async generateReply(prompt: string, _history: any[], user: User): Promise<string> {
        let output = '';
        await this.streamReply(prompt, user, (event) => {
            if (event.type === 'text.delta' && typeof (event as any).text === 'string') output += (event as any).text;
        });
        return output || 'Agentiz Assistant finished without returning a message.';
    }

    async streamReply(input: string | any[], user: User, onEvent: (event: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
        if (!this.isEnabled()) {
            throw new Error('Agentiz Assistant is not connected: set OPENHARNESS_API_KEY.');
        }
        const session = await this.getSession(user);
        for await (const event of session.send(input, { signal })) {
            onEvent(event as StreamEvent);
        }
    }

    getSessionMeta(user: User): AiAgentSessionMeta {
        const session = this.sessions.get(user.id);
        const contextTokens = session ? Math.round(JSON.stringify(session.messages ?? []).length / 4) : 0;
        return {
            model: process.env.OPENHARNESS_MODEL || DEFAULT_MODEL,
            contextWindow: Number(process.env.OPENHARNESS_CONTEXT_WINDOW) || 128_000,
            vision: false,
            turns: session?.turns ?? 0,
            totalUsage: session?.totalUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            contextTokens,
        };
    }

    getSessionHistory(user: User): any[] {
        return this.sessions.get(user.id)?.messages ?? [];
    }

    resetSession(user: User): boolean {
        return this.sessions.delete(user.id);
    }

    async compactSession(user: User): Promise<Record<string, unknown>> {
        const session = this.sessions.get(user.id);
        if (!session || !session.messages?.length) return { compacted: false };
        let tokensBefore = 0;
        let tokensAfter = 0;
        let messagesRemoved = 0;
        let done = false;
        for await (const event of session.compact()) {
            if (event.type === 'compaction.start') tokensBefore = event.tokensBefore ?? 0;
            if (event.type === 'compaction.pruned') messagesRemoved += event.messagesRemoved ?? 0;
            if (event.type === 'compaction.done') {
                tokensBefore = event.tokensBefore ?? tokensBefore;
                tokensAfter = event.tokensAfter ?? 0;
                done = true;
            }
        }
        return { compacted: done, tokensBefore, tokensAfter, messagesRemoved };
    }

    private getBaseUrl(): string {
        return process.env.OPENHARNESS_BASE_URL || DEFAULT_BASE_URL;
    }

    private async getSession(user: User): Promise<any> {
        const existing = this.sessions.get(user.id);
        if (existing) return existing;

        // @openharness/core only publishes its types behind an "exports" map, which the
        // project's classic moduleResolution can't see — go through Function() so this one
        // import resolves as `any` instead of a type error. ai/@ai-sdk/openai resolve normally.
        const dynamicImport = (specifier: string): Promise<any> => Function('specifier', 'return import(specifier)')(specifier);
        const [{ Agent, Session }, { createOpenAI }, { tool, jsonSchema }] = await Promise.all([
            dynamicImport('@openharness/core'),
            import('@ai-sdk/openai'),
            import('ai'),
        ]);

        const provider = createOpenAI({ apiKey: process.env.OPENHARNESS_API_KEY!, baseURL: this.getBaseUrl() });
        const model = process.env.OPENHARNESS_MODEL || DEFAULT_MODEL;
        const mcpAvailable = user.isAdministrator;

        const listMcpTools = tool({
            description: [
                'List MCP tools available to administrator users.',
                'Call without a group to get the compact group catalogue.',
                'Call with a group name to get full tool descriptions and input schemas for that group.',
            ].join(' '),
            inputSchema: z.object({ group: z.string().min(1).optional() }),
            execute: async (input: { group?: string }) => {
                if (!user.isAdministrator) return { error: 'MCP tools are only available for administrators.' };
                const server = this.mcpApp.server;
                if (input.group) {
                    const tools = server.listTools(input.group);
                    if (tools.length === 0) {
                        return {
                            group: input.group,
                            count: 0,
                            tools: [],
                            error: `No tools found in group "${input.group}". Check availableGroups and retry with the matching one.`,
                            availableGroups: server.listGroups(),
                        };
                    }
                    return summarizeToolResult('list_mcp_tools', { group: input.group, count: tools.length, tools });
                }
                const groups = server.listGroups();
                const tools = server.listTools().map((entry) => ({
                    name: entry.name,
                    group: entry.group,
                    mode: entry.mode,
                    description: entry.shortDescription,
                }));
                return summarizeToolResult('list_mcp_tools', { groupCount: groups.length, groups, toolCount: tools.length, tools });
            },
        });

        const callMcpTool = tool({
            description: [
                'Call a registered MCP tool by name.',
                'Only use tool names and params that came from list_mcp_tools.',
                'For tools that create, update, delete, sync, run or cancel, only call them after the user explicitly asks for that action.',
            ].join(' '),
            inputSchema: z.object({
                tool_name: z.string().min(1),
                params: z.record(z.string(), z.any()).optional(),
            }),
            execute: async (input: { tool_name: string; params?: Record<string, unknown> }) => {
                if (!user.isAdministrator) return { error: 'MCP tools are only available for administrators.' };
                try {
                    // app-mcp ships its own nested @nodeknit/app-manager copy, so its AppManager
                    // type is nominally distinct from this file's — same runtime object, so the
                    // cast is safe.
                    const result = await this.mcpApp.server.callTool(input.tool_name, input.params ?? {}, { appManager: this.appManager as any });
                    return summarizeToolResult(input.tool_name, result);
                } catch (error: any) {
                    return { error: error?.message || 'MCP tool call failed.' };
                }
            },
        });

        // Adminizer's own agent skills (current_user, list_data_models, read_model_records,
        // update_model_record, create_model_record, ...): every call re-checks this user's model
        // permissions server-side. Available to every user, not just administrators.
        const skillTools: Record<string, any> = {};
        for (const skill of this.getAgentSkills(user)) {
            skillTools[skill.id] = tool({
                description: skill.description,
                inputSchema: jsonSchema(skill.inputSchema),
                execute: async (input: Record<string, unknown>) => {
                    try {
                        const result = await this.executeAgentSkill(skill.id, input ?? {}, user);
                        return summarizeToolResult(skill.id, result);
                    } catch (error: any) {
                        return { error: error?.message || `Skill "${skill.id}" failed.` };
                    }
                },
            });
        }

        const agent = new Agent({
            name: 'Agentiz Assistant',
            model: provider.chat(model),
            instructions: false,
            maxSteps: 6,
            onError: ({ error }: { error: unknown }) => {
                console.error('[AgentizAssistant] stream error:', error instanceof Error ? error.message : error);
            },
            systemPrompt: [
                'You are the Agentiz admin assistant. Agentiz runs agent pipelines against tasks pulled from external trackers.',
                'Use list_data_models, read_model_records, update_model_record and create_model_record to inspect and edit admin data the current user may access.',
                mcpAvailable
                    ? 'Use list_mcp_tools first (without group for a compact catalogue, with a group for exact schemas), then call_mcp_tool with the exact tool_name and params.'
                    : 'MCP tools are only available to administrator users in this chat.',
                'Prefer read-only tools for diagnostics. Do not call mutating tools (create/update/delete records, agentiz.sync, agentiz.runTask, agentiz.cancelRun, ...) unless the user explicitly asked for that action.',
                // The spec is a validated JSON document; guessing its shape is the one failure this
                // assistant hit repeatedly, and the schema is only reachable through that tool.
                mcpAvailable
                    ? 'A PipelineSpec\'s "spec" field is a validated JSON document. Before creating or editing one, read its shape with call_mcp_tool("agentiz.pipelineSpecSchema", {projectId}), and send "spec" as a JSON object, never as a JSON string.'
                    : 'A PipelineSpec\'s "spec" field is a validated JSON document — send it as a JSON object, never as a JSON string, and follow the field description from list_data_models.',
            ].join('\n'),
            tools: { ...skillTools, ...(mcpAvailable ? { list_mcp_tools: listMcpTools, call_mcp_tool: callMcpTool } : {}) },
        });
        const session = new Session({ agent, contextWindow: Number(process.env.OPENHARNESS_CONTEXT_WINDOW) || 128_000 });
        this.sessions.set(user.id, session);
        return session;
    }
}
