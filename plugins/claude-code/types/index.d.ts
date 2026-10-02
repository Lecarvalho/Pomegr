/** The main agent's latest model request, as the engine reported its usage. */
export type Reading = {
  /** When the response arrived, in `$.clock.now()` milliseconds. */
  at: number
  /** Uncached input + cache read + cache write tokens of that request. */
  prompt: number
  read: number
  written: number
  model: string
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = {
  tokens?: number
  window: number
  percent?: number
  limits: Limit[]
}

/** The cache lifetime Pomegr recorded for the main agent, when it is running. */
export type Recorded = '5m' | '1h' | 'mixed' | '30m+'

/** A request that rewrote most of the prompt cache after reading it before. */
export type Refill = { at: number; written: number; idleMs: number }

/** A subagent of this session: its short label, the engine's status, its latest prompt size. */
export type AgentRow = { id: string; label: string; status: string; tokens: number | null }

/** The session progress the agent last reported through Pomegr's MCP tool. */
export type Progress = { percent: number; phase: string; etaMin: number | null; etaMax: number | null }

/** Where the line draws: its own row above the prompt, under the hint below it, or nowhere. */
export type Place = 'above' | 'below' | 'hidden'

declare module 'claude-code' {
  interface PluginState {
    pomegr: {
      main: Reading | null
      usage: Usage | null
      recorded: Recorded | null
      now: number
      agents: AgentRow[]
      progress: Progress | null
      /** Fresh tokens of each recent main-agent request (cache write + uncached input + output), oldest first. */
      requests: number[]
      place: Place
    }
  }
}
