const omitted = reason => `[Excluded: ${reason}]`;
const credentialKey = key => /^(authorization|proxy-authorization|cookie|set-cookie|access_token|refresh_token|id_token|api[_-]?key|x-api-key|client_secret|password|secret)$/i.test(key);
const binaryKey = key => /^(b64_json|file_data|image_data|audio_data|binary_data|bytes)$/i.test(key);

export function readableMessageMetadata(chat, index) {
  const message = chat.messages[index];
  if (!message) return null;
  let metadata = message.metadata, source = metadata ? 'Saved with this message' : 'Not recorded';
  if (!metadata && message.role === 'user') {
    const reply = chat.messages[index + 1];
    if (reply?.role === 'assistant' && reply.metadata?.request) {
      metadata = { sent_at: reply.metadata.started_at ?? null, request: reply.metadata.request };
      source = 'Request recovered from the paired assistant reply';
    }
  }
  const exclusions = new Map();
  function exclude(reason) {
    exclusions.set(reason, (exclusions.get(reason) ?? 0) + 1);
    return omitted(reason);
  }
  function clean(value, key = '', parent = {}) {
    if (credentialKey(key)) return exclude('Credentials and authentication headers');
    if (/^encrypted_/i.test(key) && typeof value !== 'number') return exclude('Encrypted reasoning or compaction state');
    if (binaryKey(key) && typeof value !== 'number') return exclude('Binary or encoded media');
    if ((key === 'previous_input' && Array.isArray(value)) ||
        (key === 'input' && (typeof value === 'string' || Array.isArray(value)) && 'model' in parent)) {
      return exclude('Repeated conversation input');
    }
    if (key === 'output_text' || (key === 'text' && parent.type === 'output_text') ||
        (key === 'refusal' && parent.type === 'refusal') ||
        (key === 'delta' && /^response\.(output_text|refusal)\.delta$/.test(parent.type ?? ''))) {
      return exclude('Repeated message text and text deltas');
    }
    if (typeof value === 'string') {
      if (/^data:/i.test(value)) return exclude('Binary or encoded media');
      // Keep diagnostic identifiers even if they are long. Unknown large
      // encoding-like strings are opaque payloads rather than readable text.
      if (!/(^id$|_id$|fingerprint$)/i.test(key) && value.length >= 160 && /^[A-Za-z0-9+/_=-]+$/.test(value)) {
        return exclude('Opaque encoded payloads');
      }
      if (key === 'body') {
        try { return clean(JSON.parse(value)); } catch { /* Plain HTTP error text is readable. */ }
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(item => clean(item, '', parent));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([field, child]) => [field, clean(child, field, value)]));
    }
    return value;
  }
  const readable = clean(metadata ?? {});
  return { message: { role: message.role, position: index + 1 }, source, available: Boolean(metadata),
    metadata: readable, excluded: [...exclusions].map(([reason, fields]) => ({ reason, fields })) };
}
