// Clears messages, requests and settings in the local demo database (data/app.db).
import path from 'node:path';
import { DATA_DIR } from '../server/data';
import { Store } from '../server/store';

const file = process.env.DB_FILE ?? path.join(DATA_DIR, 'app.db');
const store = new Store(file);
store.reset();
store.close();
console.log(`Reset ${file}`);
