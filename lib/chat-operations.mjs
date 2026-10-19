import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';

export const activeOperation = operation => ['queued', 'running'].includes(operation?.status);
export const operationView = record => record ? {
  id: record.id, requestId: record.request_id, chatId: record.chat_id, order: record.ordinal, kind: record.kind, status: record.status,
  revision: record.revision, prompt: record.request?.text ?? '', text: record.partial_text,
  message: record.status_message, notice: record.notice, error: record.error,
  createdAt: record.created_at, startedAt: record.started_at, finishedAt: record.finished_at,
} : null;

// Only the backend owns execution, locks, checkpoints, and terminal state.
// HTTP connections subscribe to snapshots and have no control over that work.
export class ChatOperations {
  constructor({ store, execute, onChange = () => {}, privateTtl = 15 * 60 * 1000, now = () => Date.now() }) {
    this.store = store; this.execute = execute; this.onChange = onChange; this.now = now; this.privateTtl = privateTtl;
    this.running = new Map(); this.listeners = new Map(); this.privateChats = new Map(); this.privateOperations = new Map();
    this.tasks = new Set(); this.order = 0;
    this.reaper = setInterval(() => this.reap(), 30000); this.reaper.unref();
  }
  createPrivate(folderId) {
    const chat = { id: `private-${randomUUID()}`, private: true, folderId, title: 'Private chat', titleEdited: true,
      model: '', effort: 'default', fast: false, messages: [], input: [], compactions: [] };
    const token = randomBytes(32).toString('hex');
    this.privateChats.set(chat.id, { chat, token, touched: this.now() });
    return { chat, token };
  }
  privateChat(id, token) {
    const entry = this.privateChats.get(id);
    if (!entry || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(entry.token))) return null;
    if (!this.running.has(id) && this.now() - entry.touched >= this.privateTtl) { this.forgetPrivate(id); return null; }
    entry.touched = this.now(); return entry.chat;
  }
  forgetPrivate(id) {
    this.privateChats.delete(id);
    for (const [key, operation] of this.privateOperations) if (operation.chat_id === id && !activeOperation(operation)) this.privateOperations.delete(key);
  }
  reap() {
    for (const [id, entry] of this.privateChats) if (!this.running.has(id) && this.now() - entry.touched >= this.privateTtl) this.forgetPrivate(id);
  }
  chat(id) { const chat = this.running.get(id)?.chat; return chat && !chat.private ? chat : this.store.getChat(id); }
  record(id, privateMode = false) { return privateMode ? this.privateOperations.get(id) ?? null : this.store.getOperation(id); }
  latest(chat) {
    if (!chat.private) return this.store.latestOperation(chat.id);
    return [...this.privateOperations.values()].filter(record => record.chat_id === chat.id).at(-1) ?? null;
  }
  prior(requestId, privateChat = null) {
    return privateChat ? [...this.privateOperations.values()].find(record => record.chat_id === privateChat.id && record.request_id === requestId)
      : this.store.operationForRequest(requestId);
  }
  start({ chat, newChat, request, requestId, commandHash, kind }) {
    let record = this.prior(requestId, chat?.private ? chat : null);
    if (record) {
      if (record.command_hash !== commandHash) throw Object.assign(new Error('This request ID was already used for a different command.'), { status: 409 });
      return record;
    }
    if (this.running.has(chat.id)) throw Object.assign(new Error('This chat is already working.'), { status: 409 });
    record = { id: randomUUID(), chat_id: chat.id, request_id: requestId, command_hash: commandHash, kind,
      status: 'queued', request, partial_text: '', revision: 0, created_at: new Date().toISOString() };
    if (chat.private) {
      Object.assign(chat, { model: request.model, effort: request.effort, fast: request.fast });
      record.ordinal = ++this.order; this.privateOperations.set(record.id, record);
    } else {
      record = this.store.startOperation(record, newChat ? chat : null);
      chat = this.store.getChat(record.chat_id);
    }
    const work = { chat, record, text: '', flushTimer: null };
    this.running.set(chat.id, work); this.onChange();
    const task = Promise.resolve().then(() => this.run(work));
    this.tasks.add(task);
    task.finally(() => { this.tasks.delete(task); this.onChange(); });
    return record;
  }
  update(work, changes) {
    work.record = work.chat.private ? Object.assign(work.record, changes, { revision: work.record.revision + 1 })
      : this.store.updateOperation(work.record.id, changes);
    this.publish(work, !activeOperation(work.record));
  }
  publish(work, terminal = false) {
    this.onChange();
    const event = { type: 'operation', operation: operationView(work.record), ...(terminal ? { chat: work.chat } : {}) };
    for (const listener of this.listeners.get(work.record.id) ?? []) {
      try { listener(event); } catch { this.listeners.get(work.record.id)?.delete(listener); }
    }
  }
  flush(work) {
    clearTimeout(work.flushTimer); work.flushTimer = null;
    if (work.text !== work.record.partial_text) this.update(work, { partial_text: work.text });
  }
  async run(work) {
    const { chat } = work;
    try {
      this.update(work, { status: 'running', started_at: new Date().toISOString() });
      const changes = await this.execute(work.record, chat, {
        delta: text => {
          work.text += text;
          if (!work.flushTimer && !work.persistenceError) work.flushTimer = setTimeout(() => {
            try { this.flush(work); } catch (error) { work.persistenceError = error; }
          }, 200);
        },
        status: message => { this.flush(work); this.update(work, { status_message: message }); },
        notice: message => { this.flush(work); this.update(work, { notice: message }); },
      });
      if (work.persistenceError) throw work.persistenceError;
      this.flush(work);
      if (chat.private) {
        Object.assign(chat, changes);
        this.update(work, { status: 'completed', partial_text: '', finished_at: new Date().toISOString() });
      } else {
        work.record = this.store.finishOperation(work.record.id, changes);
        Object.assign(chat, this.store.getChat(chat.id));
      }
    } catch (error) {
      clearTimeout(work.flushTimer);
      const changes = error.attempt ? { failedAttempts: [...(chat.failedAttempts ?? []), error.attempt] } : null;
      try {
        this.flush(work);
        if (chat.private) {
          if (changes) Object.assign(chat, changes);
          this.update(work, { status: 'failed', error: error.message, finished_at: new Date().toISOString() });
        } else work.record = this.store.finishOperation(work.record.id, changes, error.message);
      } catch (storageError) {
        // The last committed checkpoint remains recoverable as interrupted on
        // restart. Never pretend a failed transaction completed successfully.
        const message = `${error.message} (Operation diagnostics could not be saved: ${storageError.message})`;
        work.record = { ...work.record, status: 'failed', error: message };
        if (!chat.private) {
          try { work.record = this.store.updateOperation(work.record.id, { status: 'failed', error: message, finished_at: new Date().toISOString() }); } catch { /* Keep the prior durable checkpoint. */ }
        }
      }
    } finally {
      clearTimeout(work.flushTimer);
      this.running.delete(chat.id);
      const entry = this.privateChats.get(chat.id);
      if (entry) entry.touched = this.now();
      this.publish(work, true);
      if (chat.private && !entry) this.privateOperations.delete(work.record.id);
    }
  }
  subscribe(id, listener) {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id).add(listener);
    return () => { this.listeners.get(id)?.delete(listener); if (!this.listeners.get(id)?.size) this.listeners.delete(id); };
  }
  async idle() { while (this.tasks.size) await Promise.all([...this.tasks]); }
  dispose() { clearInterval(this.reaper); this.privateChats.clear(); this.privateOperations.clear(); this.listeners.clear(); }
}
