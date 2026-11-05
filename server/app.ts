// HTTP API for the demo UI. Thin: every route delegates to ConversationService / the store.
// Routes get the service through `withService`, so the same API runs on the local SQLite file
// (one long-lived service) and on the hosted demo (one Postgres transaction per request, on the
// visitor's own thread).
import express, { type ErrorRequestHandler } from 'express';
import { hasClaudeKey } from './agent/claudeInterpreter.js';
import { missingFields, REQUEST_TYPES, type RequestStatus } from './requests.js';
import { resolveRequest, ResolveError } from './resolutions.js';
import { createCallToken, hasVoiceKey, speak, VoiceError } from './voice.js';
import type { ConversationService } from './service.js';

const STATUSES: RequestStatus[] = ['pending_staff', 'in_progress', 'completed', 'cancelled'];

/** `thread` is the visitor's demo thread on the hosted site; the local demo has just one and ignores it. */
export type WithService = <T>(thread: string, fn: (service: ConversationService) => Promise<T>) => Promise<T>;

export interface AppOptions {
  /** The hosted demo: each browser gets its own thread (shown in the UI). */
  hosted?: boolean;
}

/** The browser's thread id (X-Demo-Thread), generated and kept in its local storage. */
const THREAD_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** One voice call: every turn said on it carries the same id. */
const CALL_ID = /^[A-Za-z0-9_-]{6,64}$/;

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function createApp(withService: WithService, options: AppOptions = {}) {
  const app = express();
  app.use(express.json());

  const thread = (req: express.Request): string => {
    const id = req.get('x-demo-thread');
    if (id === undefined) return 'default';
    if (!THREAD_ID.test(id)) throw new HttpError(400, 'X-Demo-Thread must be 8–64 letters, digits, - or _');
    return id;
  };

  const state = ({ store, data }: ConversationService) => {
    const p = data.patient;
    return {
      settings: store.getSettings(),
      /** The scenario clock right now: the configured time plus real time elapsed since it was set. */
      clock: store.now(),
      claudeAvailable: hasClaudeKey(),
      voiceAvailable: hasVoiceKey(),
      hosted: Boolean(options.hosted),
      patient: { id: p.patient_id, name: p.name, phone: p.phone },
      messages: store.listMessages(p.patient_id),
      requests: store.listRequests(p.patient_id).map((r) => ({
        ...r,
        label: REQUEST_TYPES[r.type].label,
        missing: missingFields(r.type, r.details),
      })),
    };
  };

  app.get('/api/state', async (req, res) => {
    res.json(await withService(thread(req), async (service) => state(service)));
  });

  app.post('/api/messages', async (req, res) => {
    const { author, body, replyTo, callId } = req.body ?? {};
    if (typeof body !== 'string' || !body.trim()) throw new HttpError(400, 'body is required');
    if (replyTo !== undefined && !Number.isInteger(replyTo)) throw new HttpError(400, 'replyTo must be a message id');
    if (author !== 'clinic' && author !== 'patient') throw new HttpError(400, 'author must be clinic or patient');
    if (callId !== undefined && (author !== 'patient' || typeof callId !== 'string' || !CALL_ID.test(callId))) {
      throw new HttpError(400, 'callId must be 6–64 letters, digits, - or _, on a patient message');
    }
    res.json(await withService(thread(req), async (service) => {
      if (author === 'clinic') service.sendClinicMessage(body.trim(), replyTo);
      else await service.receivePatientMessage(body.trim(), replyTo, callId ? { callId } : undefined);
      return state(service);
    }));
  });

  app.patch('/api/settings', async (req, res) => {
    const { now, agentMode } = req.body ?? {};
    if (now !== undefined && Number.isNaN(Date.parse(now))) throw new HttpError(400, 'now must be an ISO timestamp');
    if (agentMode !== undefined && !['local', 'claude'].includes(agentMode)) throw new HttpError(400, 'agentMode must be local or claude');
    res.json(await withService(thread(req), async (service) => {
      service.store.updateSettings({ now, agentMode });
      return state(service);
    }));
  });

  // Optional staff action: move a request through its lifecycle. The agent never calls this.
  app.patch('/api/requests/:id', async (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.body ?? {};
    if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`);
    res.json(await withService(thread(req), async (service) => {
      if (!service.store.getRequest(id)) throw new HttpError(404, 'not found');
      service.store.updateRequest(id, { status });
      return state(service);
    }));
  });

  // Optional staff action: close a request with what actually happened (booked for Thu 1:30,
  // refill approved, ...) and optionally text Alex. The agent then reports that outcome truthfully.
  app.post('/api/requests/:id/resolve', async (req, res) => {
    const id = Number(req.params.id);
    res.json(await withService(thread(req), async (service) => {
      try {
        resolveRequest(service, id, req.body ?? {});
      } catch (err) {
        if (err instanceof ResolveError) throw new HttpError(err.status, err.message);
        throw err;
      }
      return state(service);
    }));
  });

  // Voice calls (see server/voice.ts). The browser gets a short-lived token to transcribe Alex's speech
  // with OpenAI directly; each finished sentence is posted to /api/messages with its callId.
  app.post('/api/voice/token', async (_req, res) => {
    try {
      res.json(await createCallToken());
    } catch (err) {
      if (err instanceof VoiceError) throw new HttpError(err.status, err.message);
      throw err;
    }
  });

  app.post('/api/voice/start', async (req, res) => {
    const { callId } = req.body ?? {};
    if (typeof callId !== 'string' || !CALL_ID.test(callId)) throw new HttpError(400, 'callId is required');
    if (!hasVoiceKey()) throw new HttpError(503, 'voice calls are not enabled');
    res.json(await withService(thread(req), async (service) => {
      service.startCall(callId);
      return state(service);
    }));
  });

  // Speaks one of the clinic's messages in this thread, word for word. Only stored outbound messages
  // can be spoken, so this can't be used to voice arbitrary text.
  app.get('/api/voice/speech/:id', async (req, res) => {
    const id = Number(req.params.id);
    const text = await withService(thread(req), async ({ store }) => {
      const m = store.getMessage(id);
      if (!m || m.direction !== 'outbound') throw new HttpError(404, 'not found');
      return m.body;
    });
    try {
      const audio = await speak(text);
      res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }).send(audio);
    } catch (err) {
      if (err instanceof VoiceError) throw new HttpError(err.status, err.message);
      throw err;
    }
  });

  app.post('/api/reset', async (req, res) => {
    res.json(await withService(thread(req), async (service) => {
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
