import { createHash } from 'crypto';
import { AgentAssistantConversation } from '../../models/AgentAssistantConversation';

/**
 * Exactly the shape adminizer's `AbstractAiConversationHistoryService` declares (`AiConversation`).
 * Declared rather than imported: the pinned adminizer build does not export that module yet, and a
 * named import of a missing export is a hard failure at load time, not a type error.
 */
export type AssistantConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Array<Record<string, unknown>>;
};

/** Whatever the panel hands us as the current user; only the id is ever read (adminizer's `User`
 *  declares it optional, hence the `?`). */
type ConversationUser = { id?: number | string };

const DEFAULT_TITLE = 'New conversation';
const TITLE_MAX_CHARS = 120;
/** Per user, per agent. A safety net against unbounded growth, not a retention policy. */
const MAX_CONVERSATIONS_PER_USER = Number(process.env.AGENTIZ_ASSISTANT_HISTORY_MAX ?? 50);
/**
 * An inlined screenshot is a megabytes-long data URL. Kept in the live session, replaced by a
 * placeholder in the stored copy: every row rewrite would otherwise carry it again.
 */
const MAX_INLINE_PART_CHARS = 32_000;

/** True for a part whose payload is a base64/data-url blob rather than something a person reads. */
function isBinaryPart(part: Record<string, unknown>): boolean {
  return part.type === 'image' || part.type === 'file';
}

function partPayloadLength(part: Record<string, unknown>): number {
  const payload = part.image ?? part.data ?? part.url;
  return typeof payload === 'string' ? payload.length : 0;
}

/**
 * Replaces oversized binary parts with a text stub, leaving every message and every other part
 * exactly where it was. Truncating whole messages instead would be the cheaper trick and a bug:
 * dropping a message can separate a tool call from its result, and the provider rejects the
 * restored dialog on the next turn.
 */
export function sanitizeMessagesForStorage(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const content = message?.content;
    if (!Array.isArray(content)) return message;
    let replaced = false;
    const parts = content.map((entry) => {
      const part = entry as Record<string, unknown>;
      if (!part || typeof part !== 'object' || !isBinaryPart(part)) return entry;
      if (partPayloadLength(part) <= MAX_INLINE_PART_CHARS) return entry;
      replaced = true;
      const kind = part.type === 'image' ? 'Image' : 'File';
      const name = typeof part.filename === 'string' ? ` ${part.filename}` : '';
      return { type: 'text', text: `[${kind}${name} attached — not kept in the stored history]` };
    });
    return replaced ? { ...message, content: parts } : message;
  });
}

function titleFromMessages(messages: Array<Record<string, unknown>>): string | undefined {
  const first = messages.find((message) => message?.role === 'user');
  const content = first?.content;
  if (typeof content === 'string') return content.trim() || undefined;
  if (Array.isArray(content)) {
    const text = content.find(
      (part) => part && typeof part === 'object' && (part as { type?: string }).type === 'text',
    ) as { text?: unknown } | undefined;
    if (typeof text?.text === 'string') return text.text.trim() || undefined;
  }
  return undefined;
}

/**
 * The panel's dialog list, stored in `agentiz_assistant_conversations` and cached in this process.
 *
 * Adminizer reads this through a **synchronous** contract (`list`/`getActive`/`create`/`select`/
 * `remove`/`saveActive` all return values, not promises — see its `AiAgentController`), which a
 * table cannot answer directly. Hence the shape here: the rows are read once into memory by
 * `hydrate()` before the model is registered, every read is served from that cache, and every
 * write updates the cache first and reaches the database through one serialized queue behind it.
 * The database stays the source of truth across restarts; memory is only the reader.
 *
 * Two rules keep that queue from becoming a write amplifier. A dialog with no messages is never
 * inserted — opening the panel must not leave a row per visit — and a write whose payload hashes
 * to what was last stored is skipped, because the panel re-saves the active dialog on every poll
 * and adminizer saves it once more after each turn.
 */
export class AssistantConversationHistory {
  private readonly conversations = new Map<string, AssistantConversation[]>();
  private readonly activeIds = new Map<string, string>();
  /** Conversation id → hash of what was last written, so an unchanged save costs nothing. */
  private readonly storedHashes = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private hydrating: Promise<void> | null = null;
  private hydrated = false;

  constructor(private readonly agentId: string) {}

  /** Called by adminizer when the agent is registered; the cache is already loaded by then. */
  initialize(_agent: unknown, _adminizer: unknown): void {}

  /**
   * Reads every stored dialog of this agent into the cache. Awaited from `AppAgentiz.mount()`,
   * before the panel can reach the model — a read served from a cold cache would answer "no
   * history" and start a second dialog beside the one on disk.
   */
  async hydrate(): Promise<void> {
    // Single-flight: `getSession` retries this when a boot-time read failed, and several chats can
    // open at once.
    if (this.hydrating) return this.hydrating;
    this.hydrating = this.load().finally(() => {
      this.hydrating = null;
    });
    return this.hydrating;
  }

  private async load(): Promise<void> {
    try {
      const rows = await AgentAssistantConversation.findAll({
        where: { agentId: this.agentId },
        order: [['updatedAt', 'ASC']],
      });
      this.conversations.clear();
      this.activeIds.clear();
      this.storedHashes.clear();
      const activeAt = new Map<string, number>();
      for (const row of rows) {
        const key = String(row.userId);
        const conversation: AssistantConversation = {
          id: row.id,
          title: row.title,
          createdAt: new Date(row.createdAt).toISOString(),
          updatedAt: new Date(row.updatedAt).toISOString(),
          messages: Array.isArray(row.messages) ? row.messages : [],
        };
        this.bucket(key).push(conversation);
        this.storedHashes.set(conversation.id, this.serialize(conversation).hash);
        // The active dialog is the one selected last; with none ever selected the newest wins,
        // which is the order rows arrive in here.
        const selectedAt = row.activeAt ? new Date(row.activeAt).getTime() : 0;
        if (!this.activeIds.has(key) || selectedAt >= (activeAt.get(key) ?? 0)) {
          this.activeIds.set(key, conversation.id);
          activeAt.set(key, selectedAt);
        }
      }
      this.hydrated = true;
      console.log(`[AgentizAssistant] loaded ${rows.length} stored conversation(s) for ${this.agentId}`);
    } catch (error) {
      // A panel that answers without its history is better than an app that will not mount. Reads
      // stay empty and writes keep queueing, so the next successful write restores persistence.
      console.error('[AgentizAssistant] could not load stored conversations:', error);
    }
  }

  list(user: ConversationUser): AssistantConversation[] {
    return [...this.bucket(this.keyOf(user))].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getActive(user: ConversationUser): AssistantConversation {
    const key = this.keyOf(user);
    const active = this.bucket(key).find((conversation) => conversation.id === this.activeIds.get(key));
    return active ?? this.create(user);
  }

  create(user: ConversationUser, title = DEFAULT_TITLE): AssistantConversation {
    const key = this.keyOf(user);
    const now = new Date().toISOString();
    const conversation: AssistantConversation = {
      id: `conversation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      title: title.slice(0, TITLE_MAX_CHARS),
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.bucket(key).push(conversation);
    this.activeIds.set(key, conversation.id);
    this.prune(key);
    // Deliberately not written yet: an empty dialog is what opening the panel produces.
    return conversation;
  }

  select(user: ConversationUser, conversationId: string): AssistantConversation | undefined {
    const key = this.keyOf(user);
    const conversation = this.bucket(key).find((entry) => entry.id === conversationId);
    if (!conversation) return undefined;
    this.activeIds.set(key, conversation.id);
    if (this.storedHashes.has(conversation.id)) this.enqueue(() => this.markActive(conversation.id));
    return conversation;
  }

  remove(user: ConversationUser, conversationId: string): boolean {
    const key = this.keyOf(user);
    const conversations = this.bucket(key);
    const index = conversations.findIndex((conversation) => conversation.id === conversationId);
    if (index < 0) return false;
    conversations.splice(index, 1);
    if (this.activeIds.get(key) === conversationId) this.activeIds.delete(key);
    this.forget(conversationId);
    return true;
  }

  saveActive(
    user: ConversationUser,
    messages: Array<Record<string, unknown>>,
    title?: string,
  ): AssistantConversation {
    const conversation = this.getActive(user);
    conversation.messages = Array.isArray(messages) ? messages : [];
    conversation.updatedAt = new Date().toISOString();
    if (title) conversation.title = title.slice(0, TITLE_MAX_CHARS);
    else if (conversation.title === DEFAULT_TITLE) {
      conversation.title = titleFromMessages(conversation.messages)?.slice(0, TITLE_MAX_CHARS) ?? conversation.title;
    }
    this.persist(this.keyOf(user), conversation);
    return conversation;
  }

  /**
   * Empties the active dialog in place, keeping it selected. This is what a session reset means
   * with a stored history: dropping only the in-memory session would be undone by the next one,
   * which reads its messages back from here.
   */
  clearActive(user: ConversationUser): void {
    const conversation = this.getActive(user);
    conversation.messages = [];
    conversation.title = DEFAULT_TITLE;
    conversation.updatedAt = new Date().toISOString();
    this.persist(this.keyOf(user), conversation);
  }

  /** Waits for queued writes; used by tests and by anything that has to read the table back. */
  async flush(): Promise<void> {
    await this.queue;
  }

  private keyOf(user: ConversationUser): string {
    return String(user?.id ?? 'anonymous');
  }

  private bucket(key: string): AssistantConversation[] {
    let conversations = this.conversations.get(key);
    if (!conversations) {
      conversations = [];
      this.conversations.set(key, conversations);
    }
    return conversations;
  }

  /** The stored form of a dialog and the hash that decides whether writing it is worth anything. */
  private serialize(conversation: AssistantConversation): {
    messages: Array<Record<string, unknown>>;
    hash: string;
  } {
    const messages = sanitizeMessagesForStorage(conversation.messages);
    const hash = createHash('sha1')
      .update(conversation.title)
      .update(' ')
      .update(JSON.stringify(messages))
      .digest('hex');
    return { messages, hash };
  }

  private persist(key: string, conversation: AssistantConversation): void {
    const userId = Number(key);
    // A caller without a user id gets an in-memory dialog: the column is the owner of the row and
    // a row nobody owns could not be read back for anyone.
    if (!Number.isFinite(userId)) return;
    const known = this.storedHashes.has(conversation.id);
    // An empty dialog nobody has written yet is a panel visit, not history.
    if (!known && conversation.messages.length === 0) return;
    const { messages, hash } = this.serialize(conversation);
    if (this.storedHashes.get(conversation.id) === hash) return;
    this.storedHashes.set(conversation.id, hash);
    const record: Record<string, unknown> = {
      id: conversation.id,
      agentId: this.agentId,
      userId,
      title: conversation.title,
      messages,
      createdAt: new Date(conversation.createdAt),
      updatedAt: new Date(conversation.updatedAt),
    };
    // Written only while this dialog *is* the selected one. Passing null for the others would be
    // the same statement with the opposite meaning: it would erase which dialog to reopen.
    if (this.activeIds.get(key) === conversation.id) record.activeAt = new Date();
    this.enqueue(async () => {
      await AgentAssistantConversation.upsert(record as any);
    }, conversation.id);
  }

  private async markActive(conversationId: string): Promise<void> {
    await AgentAssistantConversation.update(
      { activeAt: new Date() },
      { where: { id: conversationId }, silent: true },
    );
  }

  private forget(conversationId: string): void {
    this.storedHashes.delete(conversationId);
    this.enqueue(async () => {
      await AgentAssistantConversation.destroy({ where: { id: conversationId } });
    }, conversationId);
  }

  /** Drops the user's oldest dialogs once the cap is exceeded — cache and table together. */
  private prune(key: string): void {
    const conversations = this.bucket(key);
    if (conversations.length <= MAX_CONVERSATIONS_PER_USER) return;
    const activeId = this.activeIds.get(key);
    const oldestFirst = [...conversations].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const conversation of oldestFirst) {
      if (conversations.length <= MAX_CONVERSATIONS_PER_USER) break;
      if (conversation.id === activeId) continue;
      conversations.splice(conversations.indexOf(conversation), 1);
      this.forget(conversation.id);
    }
  }

  /**
   * One chain for every write, so an upsert and the delete that follows it cannot race. A failed
   * write is logged and dropped: the cache still holds the dialog, and the next turn saves it
   * again — retrying here would keep a permanently failing row in front of every later write.
   */
  private enqueue(operation: () => Promise<void>, conversationId?: string): void {
    this.queue = this.queue
      .then(operation)
      .catch((error) => {
        if (conversationId) this.storedHashes.delete(conversationId);
        console.error('[AgentizAssistant] could not store conversation:', error);
      });
  }

  /** Whether `hydrate()` has read the table; false means reads are answering from an empty cache. */
  get isHydrated(): boolean {
    return this.hydrated;
  }
}
