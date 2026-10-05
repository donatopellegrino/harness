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
export function normalizeModels(data) {
  if (!Array.isArray(data.models)) throw new Error('ChatGPT returned an unexpected model catalog.');
  return data.models.filter(model => model.visibility === 'list' && typeof model.slug === 'string').map(model => {
    const advertised = model.supported_reasoning_efforts ?? model.supported_reasoning_levels;
    const efforts = Array.isArray(advertised) ? advertised.map(value => typeof value === 'string' ? value : value.effort).filter(value => EFFORTS.includes(value)) : /^gpt-6(?:\.1)?-(?:sol|astra|luna)(?:$|-)/.test(model.slug) ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high'];
    if (/^gpt-6-(sol|luna)(?:$|-)/.test(model.slug) && !advertised) efforts.unshift('none');
    return { id: model.slug, name: model.display_name ?? model.slug, efforts };
  });
}

export async function streamReply({ fetcher = fetch, endpoint = 'https://api.openai.com/v1/responses', token, model, effort, input, signal, onDelta }) {
  const request = { model, input, store: false, stream: true, include: ['reasoning.encrypted_content'] };
  if (effort !== 'default') request.reasoning = { effort };
  const response = await fetcher(endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request), signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = typeof data.detail === 'string' ? data.detail : data.error?.message ?? 'ChatGPT request failed.';
    throw new Error(`${message} (HTTP ${response.status})`);
  }
  let completed;
  const streamedOutput = new Map();
  for await (const event of parseSSE(response.body)) {
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
  return output;
}
