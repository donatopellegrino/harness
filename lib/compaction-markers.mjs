const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const messageTime = message => timestamp(message.role === 'user'
  ? message.metadata?.sent_at ?? message.metadata?.started_at
  : message.metadata?.finished_at);

export function compactionMarkers(messages, compactions = []) {
  if (!Array.isArray(compactions)) return [];
  return compactions.map(record => {
    record ??= {};
    let afterMessageCount = null;
    if (Number.isSafeInteger(record.after_message_count) && record.after_message_count >= 0 && record.after_message_count <= messages.length) {
      afterMessageCount = record.after_message_count;
    } else if (typeof record.response_id === 'string' && record.response_id) {
      const index = messages.findIndex(message => message.role === 'assistant' && message.metadata?.response?.id === record.response_id);
      if (index >= 0) afterMessageCount = index + 1;
    }
    const time = timestamp(record.completed_at);
    if (afterMessageCount === null && Number.isFinite(time)) {
      // Legacy records have no explicit boundary. Use adjacent known times;
      // missing timestamps must not be interpreted as earlier messages.
      const next = messages.findIndex(message => messageTime(message) > time);
      if (next === 0 || next > 0 && messageTime(messages[next - 1]) <= time) afterMessageCount = next;
      else if (next < 0 && messages.length && messageTime(messages.at(-1)) <= time) afterMessageCount = messages.length;
    }
    return { afterMessageCount, mode: ['manual', 'automatic'].includes(record.mode) ? record.mode : null,
      completedAt: Number.isFinite(time) ? record.completed_at : null };
  });
}
