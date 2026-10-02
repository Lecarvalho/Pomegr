import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, Place, Reading, Recorded, Usage } from '../types'
import { REQUESTS_KEPT, SECONDS_BELOW_MS, agentLabel, agentsLine, cacheState, detectRefill, line, span, tokens } from './hud'
import type { Style } from './hud'

const main = atom({ plugin: 'pomegr', key: 'main' } as const, null)
const usage = atom({ plugin: 'pomegr', key: 'usage' } as const, null)
const recorded = atom({ plugin: 'pomegr', key: 'recorded' } as const, null)
const now = atom({ plugin: 'pomegr', key: 'now' } as const, 0)
const agents = atom({ plugin: 'pomegr', key: 'agents' } as const, [])
const progress = atom({ plugin: 'pomegr', key: 'progress' } as const, null)
const requests = atom({ plugin: 'pomegr', key: 'requests' } as const, [])
const place = atom({ plugin: 'pomegr', key: 'place' } as const, 'above')

const NEXT_PLACE: Record<Place, Place> = { above: 'below', below: 'hidden', hidden: 'above' }

// Mostly the terminal's own text colors; only the brand mark, bars and marks carry color.
const COLOR: Partial<Record<Style, string>> = {
  brand: '#d9614f',
  accent: '#5b9df0',
  ok: '#3fa66b',
  warning: 'warning',
  error: 'error',
}

// The Pomegr plugin's MCP server, as /mcp lists it and as a bare install names it.
const POMEGR_SERVERS = ['plugin:pomegr:pomegr', 'pomegr']
const PROBE_RETRY_MS = 5 * 60_000
const LIMIT_STEPS = [80, 95]
const RECORDED: readonly string[] = ['5m', '1h', 'mixed', '30m+']
const OWN_PROMPTS: readonly string[] = ['composer', 'bridge', 'sdk']

function limitStep(percentUsed: number): number {
  return LIMIT_STEPS.filter(step => percentUsed >= step).length
}

function recordedLifetime(result: unknown): Recorded | null | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const data = result as { readiness?: unknown; context?: { cacheLifetime?: unknown } | null }
  if (data.readiness !== 'ready') return undefined
  const lifetime = data.context?.cacheLifetime
  return typeof lifetime === 'string' && RECORDED.includes(lifetime) ? (lifetime as Recorded) : null
}

let isTurnRunning = false
let isPomegrLinked = false
let shownBucket = 0
let probedAt = 0
let ticks = 0
// Subagents seen running since the last prompt, and each loop's latest prompt size.
const tracked = new Map<string, AgentRow>()
const agentTokens = new Map<string, number>()
const limitSteps = new Map<string, number>()

// Optional: a running Pomegr monitor knows the lifetime the provider recorded.
async function probe($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  if (!isPomegrLinked && at - probedAt < PROBE_RETRY_MS && probedAt > 0) return
  probedAt = at
  const sessionRef = `claude:${await $.session.id()}`
  for (const server of POMEGR_SERVERS) {
    try {
      const result = await $.mcp.call(server, 'get_agent_context', { session_ref: sessionRef })
      const lifetime = result.isError ? undefined : recordedLifetime(result.structuredContent)
      if (lifetime === undefined) continue
      isPomegrLinked = true
      await update($, recorded, () => lifetime)
      return
    } catch {
      // Not installed or not connected under this name.
    }
  }
  isPomegrLinked = false
  await update($, recorded, () => null)
}

async function takeUsage($: EngineInterface, next: Usage, isFirst: boolean): Promise<void> {
  await update($, usage, () => next)
  for (const limit of next.limits) {
    const step = limitStep(limit.percentUsed)
    const before = limitSteps.get(limit.kind)
    limitSteps.set(limit.kind, step)
    if (!isFirst && before !== undefined && step > before) {
      $.ui.toast(`Usage limit ${limit.kind.replace(/_/g, ' ')} reached ${Math.round(limit.percentUsed)}%`, { timeoutMs: 8000 })
    }
  }
}

async function refreshAgents($: EngineInterface): Promise<void> {
  for (const agent of await $.agent.list()) {
    if (agent.status !== 'running' && !tracked.has(agent.id)) continue
    tracked.set(agent.id, { id: agent.id, label: agentLabel(agent.type), status: agent.status, tokens: agentTokens.get(agent.id) ?? null })
  }
  const rows = [...tracked.values()]
  if (JSON.stringify(rows) !== JSON.stringify(await read($, agents))) await update($, agents, () => rows)
}

async function tick($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  ticks += 1
  const hasRunning = [...tracked.values()].some(agent => agent.status === 'running')
  if ((isTurnRunning || hasRunning) && ticks % 2 === 0) await refreshAgents($).catch(() => undefined)
  const limits = (await read($, usage))?.limits ?? []
  const state = cacheState(await read($, main), at, await read($, recorded), limits.length > 0)
  const isCounting = !isTurnRunning && state.kind === 'left' && state.leftMs < SECONDS_BELOW_MS
  const bucket = Math.floor(at / 30_000)
  if (isCounting || bucket !== shownBucket) {
    shownBucket = bucket
    await update($, now, () => at)
  }
}

// The line, and under it the agents row while there is one; `hint` leads when the line stands in the hint's place.
async function draw(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  columns: number,
  isWorking: boolean,
  hint: string | null,
) {
  const reading = await read($, main)
  const view = {
    main: reading,
    usage: await read($, usage),
    recorded: await read($, recorded),
    progress: await read($, progress),
    requests: await read($, requests),
    now: Math.max(await read($, now), reading?.at ?? 0),
    isWorking,
    columns,
  }
  const rows = [line(view), agentsLine(await read($, agents), columns)].filter(row => row.length > 0)
  const { Box, Text } = $.ui.resolve(e)

  // Above the prompt the line stands clear of the transcript and lines up with its text.
  const isBand = hint === null

  return (
    <Box flexDirection="column" paddingLeft={isBand ? 2 : 0} paddingTop={isBand ? 1 : 0}>
      {hint === null ? null : (
        <Text dimColor wrap="truncate-end">
          {hint}
        </Text>
      )}
      {rows.map(row => (
        <Text wrap="truncate-end">
          {row.map((section, index) => (
            <Text>
              {index > 0 ? <Text dimColor> │ </Text> : null}
              {section.map(part => (
                <Text color={COLOR[part.style]} dimColor={part.style === 'dim'} bold={part.style === 'strong'}>
                  {part.text}
                </Text>
              ))}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pomegr-hud', description: 'Move the Pomegr line: above the prompt, below it, hidden' })
    try {
      const measured = await $.session.usage()
      await takeUsage($, { ...measured.context, limits: measured.rateLimits }, true)
    } catch {
      // No figures yet; session.measure brings them.
    }
    void probe($).catch(() => undefined)
    $.clock.every(1000, () => void tick($).catch(() => undefined))

    return next(e)
  })

  on('command.run', { command: 'pomegr-hud' }, async $ => {
    const chosen = NEXT_PLACE[await read($, place)] ?? 'above'
    await update($, place, () => chosen)

    return { text: `Pomegr HUD: ${chosen}.` }
  })

  on('prompt.submit', ($, e, next) => {
    // Only the person's own prompt starts new work: a task notification or a scheduled
    // prompt belongs to the work under way and leaves its agents and estimate on the line.
    if (OWN_PROMPTS.includes(e.origin.kind)) {
      for (const [id, agent] of tracked) {
        if (agent.status !== 'running') tracked.delete(id)
      }
      void update($, agents, () => [...tracked.values()])
      void update($, progress, current => (current?.phase === 'complete' ? null : current))
    }

    return next(e)
  })

  // Agent-reported progress, read off the Pomegr plugin's own MCP tool calls.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (e.agentId === undefined && tool.includes('pomegr')) {
      const reported = e as unknown as { percent?: unknown; phase?: unknown; remaining_minutes_min?: unknown; remaining_minutes_max?: unknown }
      if (tool.endsWith('__clear_session_progress')) {
        await update($, progress, () => null)
      } else if (tool.endsWith('__report_session_progress') && typeof reported.percent === 'number' && typeof reported.phase === 'string') {
        const { percent, phase, remaining_minutes_min: low, remaining_minutes_max: high } = reported
        const hasEta = typeof low === 'number' && typeof high === 'number'
        await update($, progress, () => ({
          percent: Math.min(100, Math.max(0, Math.round(percent))),
          phase: phase.slice(0, 16),
          etaMin: hasEta ? Math.round(low) : null,
          etaMax: hasEta ? Math.round(high) : null,
        }))
      }
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await takeUsage($, { tokens: e.context.tokens, window: e.context.window, percent: e.context.percent, limits: e.rateLimits }, false)

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    isTurnRunning = true

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (result.usage === null) return result
    try {
      const { input_tokens, output_tokens, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: written, model } = result.usage
      const prompt = input_tokens + cacheRead + written
      if (e.agentId !== undefined) {
        agentTokens.set(e.agentId, prompt)
        await refreshAgents($)
      } else {
        const reading: Reading = { at: await $.clock.now(), prompt, read: cacheRead, written, model }
        const found = detectRefill(await read($, main), reading)
        await update($, main, () => reading)
        await update($, requests, list => [...list, input_tokens + written + output_tokens].slice(-REQUESTS_KEPT))
        if (found !== null) {
          $.ui.toast(`Cache rewritten: ${tokens(found.written)} tokens written after ${span(found.idleMs)} idle`, { timeoutMs: 8000 })
        }
      }
    } catch {
      // The line keeps its last figures.
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = false
      void probe($).catch(() => undefined)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, place)) !== 'above') return next(e)

    return draw($, e, e.props.bodyColumns - 2, e.props.isWorking, null)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if ((await read($, place)) !== 'below') return next(e)

    return draw($, e, (e.viewport?.columns ?? 80) - 2, e.props.isWorking, `${e.props.hint}${e.props.tail ?? ''}`)
  })
}
