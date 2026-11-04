// Vercel entry point: the same Express API, backed by Postgres (Neon) instead of the SQLite file.
// Each request is one locked transaction on the visitor's own thread (see server/postgres.ts). DATABASE_URL comes from the
// Neon integration; without it the function refuses to start rather than lose data silently.
import { createApp } from '../server/app.js';
import { loadClinicData } from '../server/data.js';
import { postgresStore } from '../server/postgres.js';
import { ConversationService } from '../server/service.js';

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!url) throw new Error('DATABASE_URL is not set: connect a Neon Postgres database to this Vercel project.');

const db = postgresStore(url);
const data = loadClinicData();

export default createApp((thread, fn) => db.run(thread, (store) => fn(new ConversationService(store, data))), { hosted: true });
