import type { AgentRow, Limit, Progress, Reading, Recorded, Refill, Usage } from '../types'

export type CacheState =
  | { kind: 'none' }
  | { kind: 'minimum'; idleMs: number }
  | { kind: 'left'; label: string; leftMs: number; isAssumed: boolean }
  | { kind: 'elapsed'; label: string; sinceMs: number; isAssumed: boolean }

export type View = {
  main: Reading | null
  usage: Usage | null
  recorded: Recorded | null
  progress: Progress | null
  requests: number[]
  now: number
  isWorking: boolean
  columns: number
}

const MINUTE = 60_000
const LIFETIME_MS = { '5m': 5 * MINUTE, '1h': 60 * MINUTE } as const

/** Below this prompt size a cold cache is not worth a warning. */
export const NOTABLE_PROMPT = 20_000
/** Under this much lifetime left the countdown shows seconds. */
export const SECONDS_BELOW_MS = 10 * MINUTE
/** How many recent requests the bars keep: a miniature of Pomegr's Requests chart. */
export const REQUESTS_KEPT = 8

/**
 * Where the main agent's cache lifetime stands. A lifetime Pomegr recorded is
 * used as is; without one the lifetime is assumed (1h on a subscription, 5m
 * otherwise) and marked so. Elapsed is an inference, never proof of a drop.
 */
export function cacheState(
  main: Reading | null,
  now: number,
  recorded: Recorded | null,
  hasSubscription: boolean,
): CacheState {
  if (main === null) return { kind: 'none' }
  const idleMs = Math.max(0, now - main.at)
  if (recorded === '30m+') return { kind: 'minimum', idleMs }
  const lifetime = recorded === '5m' || recorded === '1h' ? recorded : recorded === 'mixed' ? '5m' : hasSubscription ? '1h' : '5m'
  const isAssumed = recorded === null
  const label = recorded === 'mixed' ? 'mixed' : isAssumed ? `~${lifetime}` : lifetime
  const leftMs = LIFETIME_MS[lifetime] - idleMs
  return leftMs > 0
    ? { kind: 'left', label, leftMs, isAssumed }
    : { kind: 'elapsed', label, sinceMs: -leftMs, isAssumed }
}

/** How long before the lifetime ends it counts as nearing. */
export function warnBeforeMs(state: CacheState): number {
  return state.kind === 'left' && state.label.endsWith('1h') ? 5 * MINUTE : MINUTE
}

/**
 * A cautious refill: the same model read most of its prompt from cache before,
 * and now wrote most of a prompt that did not shrink. Anything else is not one.
 */
export function detectRefill(previous: Reading | null, current: Reading): Refill | null {
  if (previous === null || previous.model !== current.model) return null
  if (current.prompt < NOTABLE_PROMPT || previous.prompt <= 0) return null
  if (current.prompt < previous.prompt * 0.7) return null
  const wasRead = previous.read / previous.prompt >= 0.5
  const isRewritten = current.read / current.prompt < 0.2 && current.written / current.prompt >= 0.5
  return wasRead && isRewritten
    ? { at: current.at, written: current.written, idleMs: Math.max(0, current.at - previous.at) }
    : null
}

export function tokens(count: number): string {
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`
  return String(count)
}

/** `4:12` under ten minutes, then `52m`, `2h30`, `3d09h`. */
export function span(ms: number): string {
  const minutes = Math.floor(ms / MINUTE)
  const pad = (count: number) => String(count).padStart(2, '0')
  if (minutes >= 24 * 60) return `${Math.floor(minutes / 1440)}d${pad(Math.floor((minutes % 1440) / 60))}h`
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${pad(minutes % 60)}`
  if (ms >= SECONDS_BELOW_MS) return `${minutes}m`
  return `${minutes}:${pad(Math.floor(ms / 1000) % 60)}`
}

/** Minutes only: for a figure that redraws every half minute. */
export function coarse(ms: number): string {
  return ms < MINUTE ? '<1m' : ms < 60 * MINUTE ? `${Math.floor(ms / MINUTE)}m` : span(ms)
}

export type Style = 'plain' | 'strong' | 'dim' | 'brand' | 'accent' | 'ok' | 'warning' | 'error'
export type Part = { text: string; style: Style }
/** One stretch of the line between two dividers. */
export type Section = Part[]

const BAR_CELLS = 8
// Braille, left column only: a thin bar with a gap to the next, in four heights.
const SPARKS = '⡀⡄⡆⡇'

function level(percent: number, warnAt: number, errorAt: number, calm: Style): Style {
  return percent >= errorAt ? 'error' : percent >= warnAt ? 'warning' : calm
}

/** A thin bar: the filled cells in `style`, the rest dim. */
export function meter(fraction: number, style: Style): Part[] {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * BAR_CELLS)
  const parts: Part[] = [
    { text: '━'.repeat(filled), style },
    { text: '━'.repeat(BAR_CELLS - filled), style: 'dim' },
  ]
  return parts.filter(part => part.text !== '')
}

/**
 * One bar per recent request, its height that request's own fresh tokens
 * against the largest shown, the newest in accent. Each bar stands alone:
 * nothing is summed or carried between requests.
 */
export function requestsSection(requests: number[]): Section | null {
  if (requests.length < 2) return null
  const top = Math.max(...requests, 1)
  const bars = requests.map(value => SPARKS[Math.min(SPARKS.length - 1, Math.floor((value / top) * (SPARKS.length - 1)))] ?? '⡀')
  return [
    { text: 'requests ', style: 'plain' },
    { text: bars.slice(0, -1).join(''), style: 'dim' },
    { text: bars.at(-1) ?? '', style: 'accent' },
  ]
}

// The same shape as a limit: label, bar, percent, then the size against the window.
function contextSection(view: View): Section | null {
  const filled = view.usage?.tokens ?? view.main?.prompt
  if (filled === undefined || filled <= 0) return null
  const window = view.usage?.window ?? 0
  if (window <= 0) return [{ text: 'context ', style: 'plain' }, { text: tokens(filled), style: 'strong' }]
  const percent = view.usage?.percent ?? Math.round((filled / window) * 100)
  return [
    { text: 'context ', style: 'plain' },
    ...meter(filled / window, level(percent, 75, 90, 'ok')),
    { text: ` ${percent}%`, style: 'strong' },
    { text: ` · ${tokens(filled)}/${tokens(window)}`, style: 'dim' },
  ]
}

function eta(progress: Progress): string {
  const { etaMin, etaMax } = progress
  if (etaMin == null || etaMax == null) return ''
  const minutes = (count: number) => (count >= 60 ? span(count * MINUTE) : `${count}m`)
  return etaMin === etaMax ? ` · ~${minutes(etaMax)}` : ` · ${minutes(etaMin)}–${minutes(etaMax)}`
}

// The agent's own estimate: the phase, a bar, the percent and the time it expects is left.
function progressSection(progress: Progress): Section {
  const style: Style = progress.phase === 'blocked' ? 'warning' : progress.phase === 'complete' ? 'ok' : 'accent'
  return [
    { text: `${progress.phase} `, style: 'plain' },
    ...meter(progress.percent / 100, style),
    { text: ` ${progress.percent}%`, style: 'strong' },
    { text: eta(progress), style: 'dim' },
  ].filter(part => part.text !== '') as Section
}

// Silent while the cache is warm: a section only as the lifetime runs out, and after.
function cacheSection(view: View, hasSubscription: boolean): Section | null {
  if (view.isWorking) return null
  const state = cacheState(view.main, view.now, view.recorded, hasSubscription)
  if (state.kind === 'elapsed') return [{ text: `cache ${state.label} elapsed ${coarse(state.sinceMs)} ago`, style: 'error' }]
  if (state.kind === 'left' && state.leftMs < warnBeforeMs(state)) {
    return [{ text: `cache ${state.label} ends in ${span(state.leftMs)}`, style: 'warning' }]
  }
  return null
}

function limitSection(limit: Limit, now: number): Section {
  const label = limit.kind === 'five_hour' ? '5h' : limit.kind === 'seven_day' ? '7d' : limit.kind.replace(/_/g, ' ')
  const resetsIn = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt) - now
  return [
    { text: `${label} `, style: 'plain' },
    ...meter(limit.percentUsed / 100, level(limit.percentUsed, 80, 95, 'ok')),
    { text: ` ${Math.round(limit.percentUsed)}%`, style: 'strong' },
    ...(resetsIn > 0 ? [{ text: ` · ${span(resetsIn)}`, style: 'dim' as const }] : []),
  ]
}

function widthOf(section: Section): number {
  return section.reduce((sum, part) => sum + part.text.length, 0)
}

// Each section spends its text and a three-cell divider.
function fit(list: Section[], columns: number): { shown: Section[]; dropped: number } {
  let width = 0
  const shown: Section[] = []
  for (const section of list) {
    width += widthOf(section) + 3
    if (width > columns && shown.length > 0) break
    shown.push(section)
  }
  return { shown, dropped: list.length - shown.length }
}

/** The line's sections in order; a narrow line drops the tail. */
export function line(view: View): Section[] {
  const list: Section[] = [[{ text: '◆ ', style: 'brand' }, { text: 'Pomegr', style: 'plain' }]]
  const context = contextSection(view)
  if (context !== null) list.push(context)
  const requests = requestsSection(view.requests)
  if (requests !== null) list.push(requests)
  if (view.progress !== null) list.push(progressSection(view.progress))

  const limits = view.usage?.limits ?? []
  const cache = cacheSection(view, limits.length > 0)
  if (cache !== null) list.push(cache)
  for (const limit of limits) list.push(limitSection(limit, view.now))

  return fit(list, view.columns).shown
}

/** `caveman:cavecrew-investigator` as `cavecrew-invest…`: the type's own name, kept short. */
export function agentLabel(type: string): string {
  const name = type.slice(type.lastIndexOf(':') + 1)
  return name.length > 16 ? `${name.slice(0, 15)}…` : name
}

function agentSection(agent: AgentRow): Section {
  const size: Part[] = agent.tokens === null ? [] : [{ text: ` ${tokens(agent.tokens)}`, style: 'dim' }]
  if (agent.status === 'completed') return [{ text: agent.label, style: 'dim' }, ...size, { text: ' ✓', style: 'ok' }]
  if (agent.status === 'failed' || agent.status === 'killed') return [{ text: agent.label, style: 'dim' }, ...size, { text: ' ✗', style: 'error' }]
  return [{ text: '● ', style: 'accent' }, { text: agent.label, style: 'plain' }, ...size]
}

/**
 * The row under the line while subagents run: a count, then one section per
 * agent with its latest prompt size. Empty when there is none to show.
 */
export function agentsLine(agents: AgentRow[], columns: number): Section[] {
  if (agents.length === 0) return []
  const running = agents.filter(agent => agent.status === 'running').length
  const count = running === 0 ? 'agents done' : `${running} agent${running === 1 ? '' : 's'} running`
  const head: Section = [{ text: '╰ ', style: 'dim' }, { text: count, style: running === 0 ? 'dim' : 'plain' }]
  const { shown, dropped } = fit([head, ...agents.map(agentSection)], columns - 6)
  return dropped === 0 ? shown : [...shown, [{ text: `+${dropped}`, style: 'dim' }]]
}
