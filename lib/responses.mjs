export async function* parseSSE(body) {
  const decoder = new TextDecoder();
  let buffer = '', data = [];
  function line(value) {
    if (!value) {
      const joined = data.join('\n'); data = [];
      return joined && joined !== '[DONE]' ? JSON.parse(joined) : null;
    }
    if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
    return null;
  }
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const event = line(buffer.slice(0, newline).replace(/\r$/, ''));
      buffer = buffer.slice(newline + 1);
      if (event) yield event;
    }
  }
  buffer += decoder.decode();
  if (buffer) { const event = line(buffer.replace(/\r$/, '')); if (event) yield event; }
  const event = line(''); if (event) yield event;
}

export function responseText(output) {
  return output.filter(item => item.type === 'message').flatMap(item => item.content ?? []).map(item => item.type === 'output_text' ? item.text : item.type === 'refusal' ? item.refusal : '').join('');
}

export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const PUBLIC_CHAT_MODELS = [
  { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', supported_reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'gpt-6-sol', display_name: 'GPT-6 Sol', supported_reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', supported_reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
];
const modelID = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
export function normalizeModels(data) {
  if (!Array.isArray(data.models)) throw new Error('ChatGPT returned an unexpected model catalog.');
  const seen = new Set();
  // The account catalog can omit usable public models. Visibility controls the
  // provider's default picker, not inference admission; the API checks access.
  return [...data.models, ...PUBLIC_CHAT_MODELS].filter(model => {
    if (!modelID(model.slug) || seen.has(model.slug)) return false;
    seen.add(model.slug); return true;
  }).map(model => {
    const advertised = model.supported_reasoning_efforts ?? model.supported_reasoning_levels;
    const efforts = Array.isArray(advertised) ? [...new Set(advertised.map(value => typeof value === 'string' ? value : value?.effort).filter(value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value)))] : /^gpt-6(?:\.1)?-(?:sol|astra|luna)(?:$|-)/.test(model.slug) ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high'];
    if (/^gpt-6-(sol|luna)(?:$|-)/.test(model.slug) && !advertised) efforts.unshift('none');
    return { id: model.slug, name: model.display_name ?? model.slug, efforts };
  });
}

export function resolveModel(catalog, id) {
  if (!modelID(id)) throw new Error('Enter a valid model ID.');
  return catalog.find(model => model.id === id) ?? { id, name: id, efforts: EFFORTS };
}

export async function streamReply({ fetcher = fetch, endpoint = 'https://api.openai.com/v1/responses', token, model, effort, fast = false, input, signal, onDelta, onServiceTier, onMetadata }) {
  const request = { model, input, store: false, stream: true, include: ['reasoning.encrypted_content'] };
  if (effort !== 'default') request.reasoning = { effort };
  // The ChatGPT plan endpoint accepts the documented priority alias for Fast.
  request.service_tier = fast ? 'priority' : 'default';
  // Keep the provider payloads intact, including fields we do not yet interpret.
  // Input history is already stored separately; never archive request credentials.
  const { input: _input, ...settings } = request;
  const metadata = { request: settings, started_at: new Date().toISOString(), http: null, response: null, events: [] };
  try {
    const response = await fetcher(endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal,
    });
    metadata.http = {
      status: response.status,
      headers: Object.fromEntries([...response.headers].filter(([name]) => !/^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(name))),
    };
    if (!response.ok) {
      const body = await response.text();
      let data;
      try { data = JSON.parse(body); } catch { data = {}; }
      metadata.http.body = body;
      const message = typeof data.detail === 'string' ? data.detail : data.error?.message ?? 'ChatGPT request failed.';
      throw new Error(`${message} (HTTP ${response.status})`);
    }
    let completed;
    const streamedOutput = new Map();
    for await (const event of parseSSE(response.body)) {
      metadata.events.push(event);
      if (event.response) metadata.response = event.response;
      if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') onDelta(event.delta);
      if (event.type === 'response.output_item.done' && Number.isInteger(event.output_index) && event.item) streamedOutput.set(event.output_index, event.item);
      if (event.type === 'response.failed' || event.type === 'error') throw new Error(event.response?.error?.message ?? event.error?.message ?? event.message ?? 'ChatGPT could not complete this reply.');
      if (event.type === 'response.incomplete') throw new Error('The reply was incomplete. Please try again.');
      if (event.type === 'response.completed') completed = event.response;
    }
    if (!completed || completed.status !== 'completed' || !Array.isArray(completed.output)) throw new Error('The connection ended before the reply completed. Please try again.');
    // Some plan-usage streams omit output from the final envelope. The completed
    // item events contain the full messages and encrypted reasoning to replay.
    completed.output.forEach((item, index) => streamedOutput.set(index, item));
    const output = [...streamedOutput].sort(([a], [b]) => a - b).map(([, item]) => item);
    if (!responseText(output)) throw new Error('ChatGPT completed without a message. Please try again.');
    onServiceTier?.(completed.service_tier);
    return output;
  } catch (error) {
    metadata.error = { name: error.name, message: error.message };
    throw error;
  } finally {
    metadata.finished_at = new Date().toISOString();
    onMetadata?.(metadata);
  }
}
