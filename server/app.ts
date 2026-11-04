// HTTP API for the demo UI. Thin: every route delegates to ConversationService / the store.
// Routes get the service through `withService`, so the same API runs on the local SQLite file
// (one long-lived service) and on the hosted demo (one Postgres transaction per request).
import express, { type ErrorRequestHandler } from 'express';
import { hasClaudeKey } from './agent/claudeInterpreter.js';
import { missingFields, REQUEST_TYPES, type RequestStatus } from './requests.js';
import { resolveRequest, ResolveError } from './resolutions.js';
import type { ConversationService } from './service.js';

const STATUSES: RequestStatus[] = ['pending_staff', 'in_progress', 'completed', 'cancelled'];

export type WithService = <T>(fn: (service: ConversationService) => Promise<T>) => Promise<T>;

export interface AppOptions {
  /** The hosted demo: one shared thread for every visitor (shown in the UI). */
  sharedDemo?: boolean;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function createApp(withService: WithService, options: AppOptions = {}) {
  const app = express();
  app.use(express.json());

  const state = ({ store, data }: ConversationService) => {
    const p = data.patient;
    return {
      settings: store.getSettings(),
      /** The scenario clock right now: the configured time plus real time elapsed since it was set. */
      clock: store.now(),
      claudeAvailable: hasClaudeKey(),
      sharedDemo: Boolean(options.sharedDemo),
      patient: { id: p.patient_id, name: p.name, phone: p.phone },
      messages: store.listMessages(p.patient_id),
      requests: store.listRequests(p.patient_id).map((r) => ({
        ...r,
        label: REQUEST_TYPES[r.type].label,
        missing: missingFields(r.type, r.details),
      })),
    };
  };

  app.get('/api/state', async (_req, res) => {
    res.json(await withService(async (service) => state(service)));
  });

  app.post('/api/messages', async (req, res) => {
    const { author, body, replyTo } = req.body ?? {};
    if (typeof body !== 'string' || !body.trim()) throw new HttpError(400, 'body is required');
    if (replyTo !== undefined && !Number.isInteger(replyTo)) throw new HttpError(400, 'replyTo must be a message id');
    if (author !== 'clinic' && author !== 'patient') throw new HttpError(400, 'author must be clinic or patient');
    res.json(await withService(async (service) => {
      if (author === 'clinic') service.sendClinicMessage(body.trim(), replyTo);
      else await service.receivePatientMessage(body.trim(), replyTo);
      return state(service);
    }));
  });

  app.patch('/api/settings', async (req, res) => {
    const { now, agentMode } = req.body ?? {};
    if (now !== undefined && Number.isNaN(Date.parse(now))) throw new HttpError(400, 'now must be an ISO timestamp');
    if (agentMode !== undefined && !['local', 'claude'].includes(agentMode)) throw new HttpError(400, 'agentMode must be local or claude');
    res.json(await withService(async (service) => {
      service.store.updateSettings({ now, agentMode });
      return state(service);
    }));
  });

  // Optional staff action: move a request through its lifecycle. The agent never calls this.
  app.patch('/api/requests/:id', async (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.body ?? {};
    if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`);
    res.json(await withService(async (service) => {
      if (!service.store.getRequest(id)) throw new HttpError(404, 'not found');
      service.store.updateRequest(id, { status });
      return state(service);
    }));
  });

  // Optional staff action: close a request with what actually happened (booked for Thu 1:30,
  // refill approved, ...) and optionally text Alex. The agent then reports that outcome truthfully.
  app.post('/api/requests/:id/resolve', async (req, res) => {
    const id = Number(req.params.id);
    res.json(await withService(async (service) => {
      try {
        resolveRequest(service, id, req.body ?? {});
      } catch (err) {
        if (err instanceof ResolveError) throw new HttpError(err.status, err.message);
        throw err;
      }
      return state(service);
    }));
  });

  app.post('/api/reset', async (_req, res) => {
    res.json(await withService(async (service) => {
      const { store } = service;
      const { now, agentMode } = store.getSettings();
      store.reset();
      store.updateSettings({ now, agentMode });
      return state(service);
    }));
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (!(err instanceof HttpError)) console.error(err);
    res.status(err instanceof HttpError ? err.status : 500).json({ error: err instanceof HttpError ? err.message : 'internal error' });
  };
  app.use(onError);

  return app;
}
