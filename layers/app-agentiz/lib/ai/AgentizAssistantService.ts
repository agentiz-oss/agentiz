import { z } from 'zod';
import {
    AbstractAiModelService,
    User,
} from '@nodeknit/app-adminizer';
import type { AppManager } from '@nodeknit/app-manager';
import type { AppMCP } from '@nodeknit/app-mcp';
import { AssistantConversationHistory } from './assistantConversationHistory';

/**
 * The assistant contract adminizer 5.0.0-build.12 exports as types. `local_modules/app-adminizer`
 * pins build.7, whose `AbstractAiModelService` is `getMetadata` and nothing else, so these are
 * declared here rather than imported: structural shapes wide enough for what this file returns,
 * which is all a consumer of the newer build needs them to be. Delete them in favour of the imports
 * once the submodule moves.
 */
type AiAgentConnectionStatus = { state: string; provider?: string; baseUrl?: string; lastError?: string };
type AiAgentUiHints = Record<string, unknown>;
type AiAgentSessionMeta = Record<string, unknown>;
type AiAgentStreamEvent = { type: string; [key: string]: unknown };

/**
 * The data skills the newer build provides on the base class. Absent on build.7, and calling them
 * blind is what turned "the assistant has no data tools here" into a TypeError the first time
 * anyone opened the chat.
 */
type AgentSkillHost = {
    getAgentSkills?: (user: User) => Array<{ id: string; description: string; inputSchema: any }>;
    executeAgentSkill?: (id: string, input: Record<string, unknown>, user: User) => Promise<unknown>;
};

type StreamEvent = AiAgentStreamEvent;

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_TOOL_RESULT_CHARS = 64_000;
const MAX_TOOL_ARRAY_ITEMS = 50;
const MAX_TOOL_OBJECT_KEYS = 100;
const VISION_OFF = new Set(['0', 'false', 'no', 'off']);
const IMAGE_TOKENS_ESTIMATE = 1_200;

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

/**
 * Rough "used context" number for the panel's meter, shown until the provider reports real usage.
 * Image parts count as a flat estimate instead of their length: an inlined photo is megabytes of
 * base64 but roughly a thousand tokens, so measuring the history by JSON size would report a
 * session many times over its window the moment somebody attaches a screenshot.
 */
function estimateContextTokens(messages: unknown): number {
    let chars = 0;
    let images = 0;
    const walk = (value: unknown): void => {
        if (value === null || value === undefined) return;
        if (Array.isArray(value)) {
            value.forEach(walk);
            return;
        }
        if (typeof value === 'object') {
            const type = (value as { type?: unknown }).type;
            if (type === 'image' || type === 'file') {
                images += 1;
                return;
            }
            for (const entry of Object.values(value as Record<string, unknown>)) walk(entry);
            return;
        }
        chars += String(value).length;
    };
    walk(messages);
    return Math.round(chars / 4) + images * IMAGE_TOKENS_ESTIMATE;
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
 * env vars (OPENHARNESS_API_KEY/_BASE_URL/_MODEL/_VISION); there is no broker/auto-registration
 * here.
 */
export class AgentizAssistantService extends AbstractAiModelService {
    private readonly sessions = new Map<number, any>();

    /**
     * Dialogs live in `agentiz_assistant_conversations`, not in this process. The session map
     * above is still per-process — it holds the live openharness `Session` — but everything it
     * would lose on a restart is read back from the table by `getSession`.
     */
    private readonly conversations: AssistantConversationHistory;

    constructor(private readonly mcpApp: AppMCP, private readonly appManager: AppManager) {
        super({
            id: 'agentiz-assistant',
            name: 'Agentiz Assistant',
            description: 'Answers questions about Agentiz projects, tasks and pipeline runs using the registered MCP tools.',
        });
        this.conversations = new AssistantConversationHistory(this.id);
        // Adminizer (>= build.12) drives its dialog list through this property — its own
        // `AbstractAiConversationHistoryService`, defaulted to an in-memory one by the base
        // constructor — and calls `initialize()` on it when the model is registered. Assigning it
        // is the entire wiring; the cast is the same one the type declarations at the top of this
        // file exist for, since the pinned build.7 base class has no such member. On that build
        // nothing reads the property and the dialog is persisted anyway, from `streamReply` below.
        (this as any).conversationHistory = this.conversations;
    }

    /**
     * Reads the stored dialogs into memory. Awaited by `AppAgentiz.mount()` before the model is
     * registered: adminizer asks for the conversation list synchronously, so a cold cache would
     * answer "no history" and open a second dialog beside the stored one.
     */
    async loadConversations(): Promise<void> {
        await this.conversations.hydrate();
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
        try {
            for await (const event of session.send(input, { signal })) {
                onEvent(event as StreamEvent);
            }
        } finally {
            // Saved here rather than only where adminizer saves it (after `streamReply` returns):
            // an aborted or failed turn has already added messages to the session, and a stored
            // dialog that disagrees with the live one is worse than one turn too many. Identical
            // content is not rewritten, so adminizer's own save right after this one is free.
            this.conversations.saveActive(user, session.messages ?? []);
        }
    }

    getSessionMeta(user: User): AiAgentSessionMeta {
        const session = this.sessions.get(user.id);
        const contextTokens = session ? estimateContextTokens(session.messages ?? []) : 0;
        return {
            model: process.env.OPENHARNESS_MODEL || DEFAULT_MODEL,
            contextWindow: Number(process.env.OPENHARNESS_CONTEXT_WINDOW) || 128_000,
            vision: this.supportsVision(),
            turns: session?.turns ?? 0,
            totalUsage: session?.totalUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            contextTokens,
        };
    }

    /**
     * The **live** session's messages, deliberately not the stored dialog: adminizer reads this
     * first and takes an empty answer as "restore the stored conversation into the agent", which
     * is how a session comes back after a restart (`restoreSessionHistory` below). Answering with
     * the stored messages here would satisfy the panel and leave the agent without its context.
     */
    getSessionHistory(user: User): any[] {
        return this.sessions.get(user.id)?.messages ?? [];
    }

    /** Loads a stored dialog into the agent — the panel switching conversations, or a cold start. */
    async restoreSessionHistory(user: User, messages: Array<Record<string, unknown>>): Promise<void> {
        const session = await this.getSession(user);
        session.messages = Array.isArray(messages) ? [...messages] : [];
    }

    resetSession(user: User): boolean {
        const dropped = this.sessions.delete(user.id);
        // Emptying the stored dialog is part of the reset now: dropping only the session would be
        // undone by the next one, which reads its messages back from the table.
        this.conversations.clearActive(user);
        return dropped;
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
        // Compaction rewrites the session's messages; the stored dialog has to follow, or the next
        // restart would restore the pre-compaction history the user just paid to shrink.
        this.conversations.saveActive(user, session.messages ?? []);
        return { compacted: done, tokensBefore, tokensAfter, messagesRemoved };
    }

    /**
     * Adminizer asks this **before** the turn (`buildInput` in its AiAgentController): with
     * `false` every attached image is replaced by the text stub "[Image attached: … — the current
     * model cannot see images]", so a photo never leaves this process and the model answers that
     * it cannot see pictures — the provider behind OPENHARNESS_BASE_URL is never involved in that
     * decision. `OPENHARNESS_MODEL` is only the alias that endpoint routes on and says nothing
     * about capabilities, so this stays a plain switch: on by default, `OPENHARNESS_VISION=0`
     * puts the stub back for a text-only model.
     */
    private supportsVision(): boolean {
        const raw = (process.env.OPENHARNESS_VISION ?? '').trim().toLowerCase();
        return raw === '' || !VISION_OFF.has(raw);
    }

    private getBaseUrl(): string {
        return process.env.OPENHARNESS_BASE_URL || DEFAULT_BASE_URL;
    }

    private async getSession(user: User): Promise<any> {
        const existing = this.sessions.get(user.id);
        if (existing) return existing;

        // Last chance to get the stored dialogs in: if the read at mount failed (a database that
        // was not up yet), this is the first `await` on the path to a new session, and it is
        // single-flight, so an already-loaded cache costs one resolved promise.
        if (!this.conversations.isHydrated) await this.conversations.hydrate();

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
                // `server` is public at runtime; only the shipped declarations mark it private.
                const server = (this.mcpApp as any).server;
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
                const tools = server.listTools().map((entry: any) => ({
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
                    const result = await (this.mcpApp as any).server.callTool(input.tool_name, input.params ?? {}, { appManager: this.appManager as any });
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
        const skillHost = this as AgentSkillHost;
        for (const skill of skillHost.getAgentSkills?.(user) ?? []) {
            skillTools[skill.id] = tool({
                description: skill.description,
                inputSchema: jsonSchema(skill.inputSchema),
                execute: async (input: Record<string, unknown>) => {
                    try {
                        const result = await skillHost.executeAgentSkill!(skill.id, input ?? {}, user);
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
        // The dialog this user was in continues where it stopped, across a restart and on an
        // adminizer build whose panel never asks for a restore. `Session.messages` is documented as
        // directly replaceable, so this is an assignment rather than a replay of the turns.
        const stored = this.conversations.getActive(user).messages;
        if (stored.length) session.messages = [...stored];
        this.sessions.set(user.id, session);
        return session;
    }
}
