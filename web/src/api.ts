import type { Message, Request, Settings } from '../../server/types';

export type QueueRequest = Request & { label: string; missing: string[] };

export interface AppState {
  settings: Settings;
  clock: string;
  claudeAvailable: boolean;
  /** The hosted demo: every visitor shares this one thread. */
  sharedDemo: boolean;
  patient: { id: string; name: string; phone: string };
  messages: Message[];
  requests: QueueRequest[];
}

async function call(method: string, url: string, body?: unknown): Promise<AppState> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
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
  reset: () => call('POST', '/api/reset'),
};
