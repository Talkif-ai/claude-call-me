// The Agent Bridge pane: cards only the person at this terminal answers (approvals,
// passkeys, binding). Shared by the hub path (agent.tsx) and the local daemon path
// (daemon-bridge.ts); agent.tsx draws the pane.

import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { AgentCard } from '../types'

export const AGENT_PANE = 'call-me-agent'
export const cards = atom({ plugin: 'call-me', key: 'agentCards' } as const, [])
// What each card's buttons do; kept here (not in state, which holds plain data).
const cardActions = new Map<string, (button: string) => Promise<void>>()

export async function showCard($: EngineInterface, card: AgentCard, action: (button: string) => Promise<void>) {
  cardActions.set(card.id, action)
  await update($, cards, list => [...(list ?? []).filter(c => c.id !== card.id), card])
  await $.ui.open({ id: AGENT_PANE, title: 'Agent Bridge', focus: true, rows: Math.min(20, card.lines.length + 8) })
}

export async function closeCard($: EngineInterface, id: string) {
  cardActions.delete(id)
  const left = await update($, cards, list => (list ?? []).filter(c => c.id !== id))
  if (left.length === 0) await $.ui.close({ id: AGENT_PANE }).catch(() => undefined)
}

export async function pressCard($: EngineInterface, id: string, button: string) {
  const action = cardActions.get(id)
  await closeCard($, id)
  if (action) await action(button).catch(err => $.ui.log(`call-me (Agent Bridge): ${String(err)}`))
}
