import type { ResolveInput } from '../../server/resolutions';
import type { Message, Request, Settings } from '../../server/types';

export type QueueRequest = Request & { label: string; missing: string[] };

export interface AppState {
  settings: Settings;
  clock: string;
  claudeAvailable: boolean;
  /** The hosted demo: this browser has its own thread. */
  hosted: boolean;
  patient: { id: string; name: string; phone: string };
  messages: Message[];
  requests: QueueRequest[];
}

/**
 * On the hosted demo each browser gets its own thread: a random id kept in local storage and sent
 * with every call, so two reviewers never see each other's conversation. Locally it's ignored.
 */
function threadId(): string {
  const fresh = () => (crypto.randomUUID?.() ?? `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  try {
    const saved = localStorage.getItem('sapling-demo-thread');
    if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved;
    const id = fresh();
    localStorage.setItem('sapling-demo-thread', id);
    return id;
  } catch {
    return fresh(); // storage blocked: a thread for this page load only
  }
}
const THREAD = threadId();

async function call(method: string, url: string, body?: unknown): Promise<AppState> {
  const res = await fetch(url, {
    method,
    headers: { 'X-Demo-Thread': THREAD, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json();
}

export const api = {
  state: () => call('GET', '/api/state'),
  send: (author: 'clinic' | 'patient', body: string, replyTo?: number) => call('POST', '/api/messages', { author, body, replyTo }),
  settings: (patch: Partial<Settings>) => call('PATCH', '/api/settings', patch),
  setStatus: (id: number, status: string) => call('PATCH', `/api/requests/${id}`, { status }),
  resolve: (id: number, body: ResolveInput) => call('POST', `/api/requests/${id}/resolve`, body),
  reset: () => call('POST', '/api/reset'),
};
