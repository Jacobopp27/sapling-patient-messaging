import path from 'node:path';
import { createApp } from './app.js';
import { DATA_DIR, loadClinicData } from './data.js';
import { ConversationService } from './service.js';
import { Store } from './store.js';

try { process.loadEnvFile('.env'); } catch { /* .env is optional */ }

const dbFile = process.env.DB_FILE ?? path.join(DATA_DIR, 'app.db');
const store = new Store(dbFile);
const service = new ConversationService(store, loadClinicData());
const port = Number(process.env.PORT ?? 3001);

// Local demo: one long-lived service on the SQLite file.
createApp((_thread, fn) => fn(service)).listen(port, () => {
  const { now, agentMode } = store.getSettings();
  console.log(`API on http://localhost:${port} · db ${dbFile} · now ${now} · agent ${agentMode}`);
});
