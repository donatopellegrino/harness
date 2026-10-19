export const operationActive = operation => ['queued', 'running'].includes(operation?.status);
export const commandId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

export async function observeOperation({ fetcher = fetch, path, signal, onSnapshot, onConnection = () => {}, onUnavailable = () => {}, retryMs = 500 }) {
  while (!signal.aborted) {
    try {
      const response = await fetcher(path, { signal });
      if (!response.ok) throw Object.assign(new Error((await response.json()).error ?? 'Could not observe the operation.'), { status: response.status });
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', terminal = false;
      onConnection('');
      try {
        while (!signal.aborted) {
          const chunk = await reader.read();
          buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
          if (chunk.done && buffer.trim()) buffer += '\n';
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            const event = JSON.parse(line);
            if (signal.aborted) return;
            onSnapshot(event); terminal = !operationActive(event.operation);
          }
          if (chunk.done || terminal) break;
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (terminal || signal.aborted) return;
      throw new Error('The observation connection ended.');
    } catch (error) {
      if (signal.aborted) return;
      onConnection(error.status === 404 ? error.message : 'Connection lost. Reconnecting to backend…');
      if (error.status === 404) { onUnavailable(); return; }
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, retryMs); signal.addEventListener('abort', finish, { once: true });
      });
    }
  }
}
