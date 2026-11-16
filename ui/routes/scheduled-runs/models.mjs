// ui/routes/scheduled-runs/models.mjs — feature "scheduled-runs" (docs/scheduled-runs.md): Models… on a scheduled run.
import { actorOf } from '../../../src/core/identity.mjs';
import { ModelSwitchError } from '../../../src/core/model-switch.mjs';
import { describeScheduledModels, switchScheduledModels } from '../../../src/core/schedule-models.mjs';
import { scheduleSignature } from '../../../src/core/scheduler.mjs';
import { emitChanged, scheduleSig } from '../../server.mjs';

/** A model-switch failure → the shared envelope (ModelSwitchError carries code + status). */
function modelSwitchReply(res, err) {
  if (err instanceof ModelSwitchError) return res.status(err.status).json({ error: err.message, code: err.code });
  return res.status(500).json({ error: err && err.message ? err.message : String(err) });
}

export function register(app) {

// Models… on a scheduled run (src/core/schedule-models.mjs): a one-off ticket's or a repeating series' agent stages with
// their stored picks, and the edit (a series also rewrites its waiting runs). Errors use the model-switch envelope.
app.get('/api/schedules/:id/models', async (req, res) => {
  try { res.json(await describeScheduledModels(req.params.id)); }
  catch (err) { modelSwitchReply(res, err); }
});
app.post('/api/schedules/:id/models', async (req, res) => {
  try {
    const out = await switchScheduledModels(req.params.id, { changes: req.body?.changes, by: actorOf(req) });
    if (out.changed.length) {
      emitChanged('schedules-changed', 'updated');
      emitChanged('notifications-changed');
      // Announced above: re-baseline the tick's probe so its next pass does not repaint it again as 'external'.
      scheduleSig.last = scheduleSignature();
    }
    res.json(out);
  } catch (err) { modelSwitchReply(res, err); }
});
}
