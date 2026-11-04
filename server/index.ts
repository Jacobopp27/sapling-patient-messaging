import path from 'node:path';
import { createApp } from './app';
import { DATA_DIR, loadClinicData } from './data';
import { ConversationService } from './service';
import { Store } from './store';

try { process.loadEnvFile('.env'); } catch { /* .env is optional */ }

const dbFile = process.env.DB_FILE ?? path.join(DATA_DIR, 'app.db');
const store = new Store(dbFile);
const service = new ConversationService(store, loadClinicData());
const port = Number(process.env.PORT ?? 3001);

createApp(service).listen(port, () => {
  const { now, agentMode } = store.getSettings();
  console.log(`API on http://localhost:${port} · db ${dbFile} · now ${now} · agent ${agentMode}`);
});
