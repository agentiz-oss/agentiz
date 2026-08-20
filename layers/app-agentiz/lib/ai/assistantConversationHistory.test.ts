import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sequelize } from 'sequelize-typescript';
import { AgentAssistantConversation } from '../../models/AgentAssistantConversation';
import { AssistantConversationHistory, sanitizeMessagesForStorage } from './assistantConversationHistory';

const AGENT = 'agentiz-assistant';
const user = { id: 7 };
const other = { id: 8 };

const text = (role: string, value: string) => ({ role, content: [{ type: 'text', text: value }] });

describe('AssistantConversationHistory', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: ':memory:',
      logging: false,
      models: [AgentAssistantConversation],
    });
  });

  afterAll(async () => sequelize.close());

  beforeEach(async () => {
    await sequelize.sync({ force: true });
  });

  it('keeps a dialog across a restart, as the active one', async () => {
    const history = new AssistantConversationHistory(AGENT);
    await history.hydrate();
    history.saveActive(user, [text('user', 'сколько воркеров живо?'), text('assistant', 'Три.')]);
    await history.flush();

    const restarted = new AssistantConversationHistory(AGENT);
    await restarted.hydrate();
    const active = restarted.getActive(user);
    expect(active.messages).toHaveLength(2);
    // The title is taken from the first user message when the dialog was never named.
    expect(active.title).toBe('сколько воркеров живо?');
    expect(restarted.list(user)).toHaveLength(1);
  });

  it('does not store a dialog nobody has written in', async () => {
    const history = new AssistantConversationHistory(AGENT);
    await history.hydrate();
    history.getActive(user);
    history.saveActive(user, []);
    await history.flush();

    expect(await AgentAssistantConversation.count()).toBe(0);
  });

  it('reopens the dialog that was selected last, not the newest one', async () => {
    const history = new AssistantConversationHistory(AGENT);
    await history.hydrate();
    history.saveActive(user, [text('user', 'первый')]);
    const first = history.getActive(user).id;
    history.create(user);
    history.saveActive(user, [text('user', 'второй')]);
    history.select(user, first);
    await history.flush();

    const restarted = new AssistantConversationHistory(AGENT);
    await restarted.hydrate();
    expect(restarted.getActive(user).id).toBe(first);
    expect(restarted.list(user)).toHaveLength(2);
  });

  it('keeps users apart and deletes only what was removed', async () => {
    const history = new AssistantConversationHistory(AGENT);
    await history.hydrate();
    history.saveActive(user, [text('user', 'мой диалог')]);
    history.saveActive(other, [text('user', 'чужой диалог')]);
    const mine = history.getActive(user).id;
    await history.flush();

    expect(history.list(other)).toHaveLength(1);
    expect(history.remove(user, mine)).toBe(true);
    await history.flush();

    const restarted = new AssistantConversationHistory(AGENT);
    await restarted.hydrate();
    expect(restarted.list(user)).toHaveLength(0);
    expect(restarted.list(other)).toHaveLength(1);
  });

  it('empties the stored dialog on clearActive, keeping it selected', async () => {
    const history = new AssistantConversationHistory(AGENT);
    await history.hydrate();
    history.saveActive(user, [text('user', 'забудь это')]);
    const id = history.getActive(user).id;
    history.clearActive(user);
    await history.flush();

    const restarted = new AssistantConversationHistory(AGENT);
    await restarted.hydrate();
    expect(restarted.getActive(user).id).toBe(id);
    expect(restarted.getActive(user).messages).toHaveLength(0);
  });

  it('writes nothing when a save repeats what is already stored', async () => {
    const history = new AssistantConversationHistory(AGENT);
    await history.hydrate();
    const messages = [text('user', 'привет')];
    history.saveActive(user, messages);
    await history.flush();

    const upsert = vi.spyOn(AgentAssistantConversation, 'upsert');
    // Adminizer re-saves the active dialog on every poll of the panel, and once more after each
    // turn — a rewrite per poll is what this guard exists for.
    history.saveActive(user, messages);
    history.saveActive(user, messages);
    await history.flush();
    expect(upsert).not.toHaveBeenCalled();

    history.saveActive(user, [...messages, text('assistant', 'здравствуйте')]);
    await history.flush();
    expect(upsert).toHaveBeenCalledTimes(1);
    upsert.mockRestore();
  });

  it('stores an inlined image as a placeholder and leaves the message structure alone', async () => {
    const image = `data:image/png;base64,${'A'.repeat(40_000)}`;
    const messages = [
      { role: 'user', content: [{ type: 'image', image }, { type: 'text', text: 'что тут?' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Скриншот логов.' }] },
    ];

    const stored = sanitizeMessagesForStorage(messages);
    expect(stored).toHaveLength(2);
    expect((stored[0].content as any[])[0]).toEqual({
      type: 'text',
      text: '[Image attached — not kept in the stored history]',
    });
    expect((stored[0].content as any[])[1]).toEqual({ type: 'text', text: 'что тут?' });

    const history = new AssistantConversationHistory(AGENT);
    await history.hydrate();
    history.saveActive(user, messages);
    await history.flush();

    const row = await AgentAssistantConversation.findOne();
    expect(JSON.stringify(row!.messages)).not.toContain('AAAA');
    // The live dialog keeps the real image; only the stored copy is a stub.
    expect(JSON.stringify(history.getActive(user).messages)).toContain('AAAA');
  });
});
