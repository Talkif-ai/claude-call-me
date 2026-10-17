/** One line of bridge traffic, as the debug pane shows it. */
export type TrafficEntry = {
  /** Local time, HH:MM:SS. */
  at: string
  /** in: from the bridge; out: to the bridge; info: state; error: something failed. */
  dir: 'in' | 'out' | 'info' | 'error'
  /** The account the traffic belongs to (personal, org, …). */
  account: string
  /** What happened, short: turn, ask, offer, claim, ack, answer, event, recap, ring, register, … */
  kind: string
  /** The rest, one line. */
  detail: string
}

/** One card of the Agent Bridge pane: something only the person at this terminal answers. */
export type AgentCard = {
  id: string
  title: string
  lines: string[]
  /** Shown verbatim (an action's exact input). */
  code?: string
  buttons: { key: string; label: string; primary?: boolean }[]
}

declare module 'claude-code' {
  interface PluginState {
    'call-me': { traffic: TrafficEntry[]; agentCards: AgentCard[] }
  }
}
