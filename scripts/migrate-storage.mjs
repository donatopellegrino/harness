import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.mjs';

const directory = resolve(process.argv[2] ?? join(dirname(dirname(fileURLToPath(import.meta.url))), '.data'));
const port = Number(process.env.PORT ?? 43187);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be between 0 and 65535.');
// Reserve the backend port throughout migration. An old JSON backend must not
// write while its files are being imported, verified, and removed.
const guard = createServer(socket => socket.destroy());
try {
  await new Promise((resolve, reject) => {
    guard.once('error', reject);
    guard.listen(port, '127.0.0.1', resolve);
  });
  const store = new Store(directory, { migrateLegacy: true });
  try {
    const result = store.migration;
    console.log('Storage ' + result.status + ': ' + (result.chats ?? 0) + ' chats, ' + (result.messages ?? 0) + ' messages, ' + (result.folders ?? 0) + ' folders.');
    console.log('Database: ' + store.path);
    if (result.backup) console.log('Verified migration backup: ' + result.backup);
    if (store.schemaUpgrade) {
      console.log('Context storage upgraded: ' + store.schemaUpgrade.items + ' ordered items verified.');
      console.log('Verified schema backup: ' + store.schemaUpgrade.backup);
    }
  } finally { store.close(); }
} catch (error) {
  console.error(error.code === 'EADDRINUSE' ? 'Stop the running harness before migrating; its backend port is in use.' : error.message);
  process.exitCode = 1;
} finally {
  if (guard.listening) await new Promise(resolve => guard.close(resolve));
}
