import { handleSignalObservation, SIGNAL_OBSERVATION_PATH, type SignalObservationEnv } from './routes/signal-observation'
import worker from './index_agent_context'
import type { AgentContextEnv } from './agent-context'
import { consumeScheduledRecoveryReads, type ScheduledRecoveryReadEnv } from './live/scheduled-recovery-read'
import { discoverScheduledRecovery, type ScheduledRecoveryDiscoveryEnv } from './live/scheduled-recovery-discovery'
import {
  evaluateRequestAdmission,
  purgeExpiredRequestAdmissionCounters,
  requestAdmissionFailureResponse,
} from './request-admission-boundary'

export default {
  async fetch(
    request: Request,
    env: AgentContextEnv & SignalObservationEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const admission = await evaluateRequestAdmission(request, env)
    if (admission.status !== 'allowed') {
      return requestAdmissionFailureResponse(request, env, admission)
    }

    // Inspect persisted history after admission, before legacy schema/bootstrap writes.
    if (new URL(request.url).pathname === SIGNAL_OBSERVATION_PATH) {
      return handleSignalObservation(request, env)
    }
    return worker.fetch(request, env, ctx)
  },

  async scheduled(event: ScheduledEvent, env: AgentContextEnv & ScheduledRecoveryDiscoveryEnv & ScheduledRecoveryReadEnv, ctx: ExecutionContext): Promise<void> {
    // Keep the admission table bounded without changing any existing cron job.
    ctx.waitUntil(purgeExpiredRequestAdmissionCounters(env))
    if (event.cron === '*/5 * * * *') {
      ctx.waitUntil((async () => {
        await discoverScheduledRecovery(env, event.scheduledTime)
        await consumeScheduledRecoveryReads(env, Date.now())
      })())
    }
    await worker.scheduled(event, env, ctx)
  },
}
