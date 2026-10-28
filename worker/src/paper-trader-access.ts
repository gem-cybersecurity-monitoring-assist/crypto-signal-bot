// Paper execution requires an ACTIVE profile holding a current TRADER role with
// GLOBAL scope. Roles arrive already filtered to current grants (not revoked, not
// expired) by the management /me lookup; this decides only on scope and status.

export interface PaperTraderIdentity {
  access_allowed?: boolean
  profile?: { actor_id?: unknown; status?: unknown } | null
  roles?: ReadonlyArray<{ role?: unknown; scope_type?: unknown; scope_key?: unknown }> | null
}

export type PaperTraderAccess =
  | { allowed: true; actorId: string }
  | { allowed: false; status: 403; code: 'ACCOUNT_INACTIVE' | 'TRADER_ROLE_REQUIRED'; error: string }

export function evaluatePaperTraderAccess(identity: PaperTraderIdentity | null): PaperTraderAccess {
  const actorId = typeof identity?.profile?.actor_id === 'string' ? identity.profile.actor_id : ''
  const active = identity?.access_allowed === true && identity?.profile?.status === 'ACTIVE'
  if (!actorId || !active) {
    return {
      allowed: false,
      status: 403,
      code: 'ACCOUNT_INACTIVE',
      error: 'The authenticated account is not active.',
    }
  }

  const hasGlobalTrader = (identity?.roles ?? []).some((role) => (
    role.role === 'TRADER'
    && role.scope_type === 'GLOBAL'
    && role.scope_key === 'global'
  ))
  if (!hasGlobalTrader) {
    return {
      allowed: false,
      status: 403,
      code: 'TRADER_ROLE_REQUIRED',
      error: 'A current GLOBAL TRADER role is required for paper execution.',
    }
  }

  return { allowed: true, actorId }
}
