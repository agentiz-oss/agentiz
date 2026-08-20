import { Table, Column, Model, DataType, Default } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional } from 'sequelize';
import { randomUUID } from 'crypto';

/**
 * One stored dialog of an admin AI assistant — the history the chat panel lists and reopens.
 *
 * Before this table the whole thing lived in a `Map` inside the service: a deploy, a crash or the
 * dev watcher restarting silently ended every conversation, and the model lost the context of a
 * dialog a person was in the middle of. The row is the source of truth now; the process keeps only
 * a cache of it (`lib/ai/assistantConversationHistory.ts`).
 *
 * Keyed by `agentId` + `userId`, not by user alone: `agentId` is the registered
 * `AbstractAiModelService.id`, so a second assistant registered later stores its dialogs here too
 * without meeting this one's. A dialog is private to its author — there is deliberately no
 * `@AdminizerModel` on this class, because the generic CRUD screens it would generate hand every
 * account with model permissions a reader for somebody else's chat.
 *
 * `messages` is the ai-sdk `ModelMessage[]` of that dialog, exactly as the agent session holds it,
 * so restoring is an assignment rather than a translation. Inlined images are stored as a short
 * placeholder part instead of their base64 (see `sanitizeMessagesForStorage`): the shape stays
 * valid for a later turn, and one screenshot does not put megabytes into every row rewrite.
 */
@Table({ tableName: 'agentiz_assistant_conversations', timestamps: true })
export class AgentAssistantConversation extends Model<
  InferAttributes<AgentAssistantConversation>,
  InferCreationAttributes<AgentAssistantConversation>
> {
  @Default(() => randomUUID())
  @Column({ type: DataType.STRING, primaryKey: true })
  declare id: CreationOptional<string>;

  /** Registered AI model id — `agentiz-assistant` today; one table serves every agent. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare agentId: string;

  /** Adminizer UserAP id, the same number `AgentProject.ownerId` holds. */
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare userId: number;

  /** Shown in the panel's dialog list; derived from the first user message when not given. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare title: string;

  /** ai-sdk ModelMessage[] — the dialog itself. */
  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare messages: CreationOptional<Array<Record<string, unknown>>>;

  /**
   * When this dialog was last made the active one. The user's active dialog is the greatest
   * `activeAt` — a single-row write on select, instead of a boolean flag whose "exactly one true"
   * invariant every write would have to maintain across the user's other rows.
   */
  @Column({ type: DataType.DATE, allowNull: true })
  declare activeAt: CreationOptional<Date | null>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare createdAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, defaultValue: DataType.NOW })
  declare updatedAt: CreationOptional<Date>;
}
