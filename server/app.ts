// HTTP API for the local demo UI. Thin: every route delegates to ConversationService / Store.
import express from 'express';
import { hasClaudeKey } from './agent/claudeInterpreter';
import { missingFields, REQUEST_TYPES, type RequestStatus } from './requests';
import type { ConversationService } from './service';

const STATUSES: RequestStatus[] = ['pending_staff', 'in_progress', 'completed', 'cancelled'];

export function createApp(service: ConversationService) {
  const { store, data } = service;
  const app = express();
  app.use(express.json());

  const state = () => {
    const p = data.patient;
    return {
      settings: store.getSettings(),
      /** The scenario clock right now: the configured time plus real time elapsed since it was set. */
      clock: store.now(),
      claudeAvailable: hasClaudeKey(),
      patient: { id: p.patient_id, name: p.name, phone: p.phone },
      messages: store.listMessages(p.patient_id),
      requests: store.listRequests(p.patient_id).map((r) => ({
        ...r,
        label: REQUEST_TYPES[r.type].label,
        missing: missingFields(r.type, r.details),
      })),
    };
  };

  app.get('/api/state', (_req, res) => { res.json(state()); });

  app.post('/api/messages', async (req, res) => {
    const { author, body, replyTo } = req.body ?? {};
    if (typeof body !== 'string' || !body.trim()) return void res.status(400).json({ error: 'body is required' });
    if (replyTo !== undefined && !Number.isInteger(replyTo)) return void res.status(400).json({ error: 'replyTo must be a message id' });
    if (author === 'clinic') service.sendClinicMessage(body.trim(), replyTo);
    else if (author === 'patient') await service.receivePatientMessage(body.trim(), replyTo);
    else return void res.status(400).json({ error: 'author must be clinic or patient' });
    res.json(state());
  });

  app.patch('/api/settings', (req, res) => {
    const { now, agentMode } = req.body ?? {};
    if (now !== undefined && Number.isNaN(Date.parse(now))) return void res.status(400).json({ error: 'now must be an ISO timestamp' });
    if (agentMode !== undefined && !['local', 'claude'].includes(agentMode)) return void res.status(400).json({ error: 'agentMode must be local or claude' });
    store.updateSettings({ now, agentMode });
    res.json(state());
  });

  // Optional staff action: move a request through its lifecycle. The agent never calls this.
  app.patch('/api/requests/:id', (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.body ?? {};
    if (!store.getRequest(id)) return void res.status(404).json({ error: 'not found' });
    if (!STATUSES.includes(status)) return void res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
    store.updateRequest(id, { status });
    res.json(state());
  });

  app.post('/api/reset', (_req, res) => {
    const { now, agentMode } = store.getSettings();
    store.reset();
    store.updateSettings({ now, agentMode });
    res.json(state());
  });

  return app;
}
