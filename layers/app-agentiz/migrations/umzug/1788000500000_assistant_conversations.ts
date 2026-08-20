import { DataTypes } from 'sequelize';

type QI = {
  createTable: (table: string, attributes: Record<string, unknown>) => Promise<unknown>;
  dropTable: (table: string) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  removeIndex: (table: string, index: string) => Promise<unknown>;
};

const CONVERSATIONS = 'agentiz_assistant_conversations';

/**
 * Persisted dialogs of the admin assistant (see models/AgentAssistantConversation.ts). Until this
 * table the history was a process-local Map, so every deploy ended every conversation.
 *
 * The index is `(agentId, userId, updatedAt)`: every read is "this user's dialogs with this agent,
 * newest first", which is also the order the panel's list is drawn in.
 */
export async function up({ context }: { context: QI }) {
  await context.createTable(CONVERSATIONS, {
    id: { type: DataTypes.STRING, primaryKey: true },
    agentId: { type: DataTypes.STRING, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    title: { type: DataTypes.STRING, allowNull: false },
    messages: { type: DataTypes.JSON, allowNull: false },
    activeAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
  await context.addIndex(CONVERSATIONS, ['agentId', 'userId', 'updatedAt'], {
    name: 'agentiz_assistant_conversations_agent_user_idx',
  });
}

export async function down({ context }: { context: QI }) {
  await context.removeIndex(CONVERSATIONS, 'agentiz_assistant_conversations_agent_user_idx');
  await context.dropTable(CONVERSATIONS);
}
