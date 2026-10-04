import { expect, test } from 'claude-code/testing'

import type { Reading } from '../types'
import type { Section } from '../hooks/hud'
import { PROBE_RETRY_MS, agentLabel, agentsLine, cacheState, detectRefill, line, meter, requestsSection, shouldProbe, span, tokens, toolName } from '../hooks/hud'

const MINUTE = 60_000
const warm: Reading = { at: 0, prompt: 110_000, read: 100_000, written: 9_000, model: 'claude-opus-5-5' }
const view = {
  main: warm,
  usage: {
    tokens: 110_000,
    window: 1_000_000,
    percent: 11,
    limits: [
      { kind: 'five_hour', percentUsed: 62, resetsAt: new Date(158 * MINUTE).toISOString() },
      { kind: 'seven_day', percentUsed: 96 },
    ],
  },
  recorded: null,
  progress: null,
  requests: [],
  now: 8 * MINUTE,
  isWorking: false,
  columns: 140,
}
const text = (sections: Section[]) => sections.map(section => section.map(part => part.text).join(''))

test('assumes 1h on a subscription and 5m without one, and says so', () => {
  expect(cacheState(warm, 10 * MINUTE, null, true)).toEqual({ kind: 'left', label: '~1h', leftMs: 50 * MINUTE, isAssumed: true })
  expect(cacheState(warm, 10 * MINUTE, null, false)).toEqual({ kind: 'elapsed', label: '~5m', sinceMs: 5 * MINUTE, isAssumed: true })
})

test('a lifetime Pomegr recorded replaces the assumption', () => {
  expect(cacheState(warm, 2 * MINUTE, '5m', true)).toEqual({ kind: 'left', label: '5m', leftMs: 3 * MINUTE, isAssumed: false })
  expect(cacheState(warm, 2 * MINUTE, '30m+', true)).toEqual({ kind: 'minimum', idleMs: 2 * MINUTE })
  expect(cacheState(null, 0, '1h', true)).toEqual({ kind: 'none' })
})

test('a refill needs a prior cached read and a rewritten prompt of the same model', () => {
  const cold: Reading = { ...warm, at: 70 * MINUTE, prompt: 112_000, read: 0, written: 111_000 }
  expect(detectRefill(warm, cold)).toEqual({ at: 70 * MINUTE, written: 111_000, idleMs: 70 * MINUTE })
  expect(detectRefill(null, cold)).toBe(null)
  expect(detectRefill(warm, { ...cold, model: 'other' })).toBe(null)
  expect(detectRefill(warm, { ...cold, prompt: 30_000, written: 29_000 })).toBe(null)
  expect(detectRefill(warm, { ...warm, at: MINUTE })).toBe(null)
})

test('formats tokens and spans', () => {
  expect(tokens(111_289)).toBe('111k')
  expect(tokens(1_000_000)).toBe('1M')
  expect(tokens(1_200_000)).toBe('1.2M')
  expect(span(4 * MINUTE + 12_000)).toBe('4:12')
  expect(span(52 * MINUTE)).toBe('52m')
  expect(span(150 * MINUTE)).toBe('2h30')
  expect(span((3 * 24 + 9) * 60 * MINUTE)).toBe('3d09h')
})

test('a meter fills in its style and leaves the rest dim', () => {
  expect(meter(0.5, 'ok')).toEqual([{ text: '━━━━', style: 'ok' }, { text: '━━━━', style: 'dim' }])
  expect(meter(0, 'ok')).toEqual([{ text: '━━━━━━━━', style: 'dim' }])
  expect(meter(1, 'error')).toEqual([{ text: '━━━━━━━━', style: 'error' }])
})

test('request bars scale to the largest request and mark the newest', () => {
  expect(requestsSection([4_000])).toBe(null)
  expect(requestsSection([1_000, 50_000, 0, 100_000])).toEqual([
    { text: 'requests ', style: 'plain' },
    { text: '⡀⡄⡀', style: 'dim' },
    { text: '⡇', style: 'accent' },
  ])
  expect(text(line({ ...view, requests: [2_000, 9_000, 3_000] }))[2]).toBe('requests ⡀⡇⡄')
})

test('the line lists brand, context and limits, and drops the tail when narrow', () => {
  expect(text(line(view))).toEqual(['◆ Pomegr', 'context ━━━━━━━━ 11% · 110k/1M', '5h ━━━━━━━━ 62% · 2h30', '7d ━━━━━━━━ 96%'])
  expect(line(view)[2]).toEqual([
    { text: '5h ', style: 'plain' },
    { text: '━━━━━', style: 'ok' },
    { text: '━━━', style: 'dim' },
    { text: ' 62%', style: 'strong' },
    { text: ' · 2h30', style: 'dim' },
  ])
  expect(line(view)[3]?.[1]).toEqual({ text: '━━━━━━━━', style: 'error' })
  expect(line(view)[1]?.slice(0, 3)).toEqual([
    { text: 'context ', style: 'plain' },
    { text: '━', style: 'ok' },
    { text: '━━━━━━━', style: 'dim' },
  ])
  expect(line({ ...view, usage: { ...view.usage, tokens: 800_000, percent: 80 } })[1]?.[1]).toEqual({ text: '━━━━━━', style: 'warning' })
  expect(text(line({ ...view, columns: 48 }))).toEqual(['◆ Pomegr', 'context ━━━━━━━━ 11% · 110k/1M'])
  expect(text(line({ ...view, main: null, usage: null }))).toEqual(['◆ Pomegr'])
})

test('the cache section shows only as the lifetime runs out, and after', () => {
  expect(text(line(view)).some(section => section.startsWith('cache'))).toBe(false)
  expect(line({ ...view, now: 57 * MINUTE })[2]).toEqual([{ text: 'cache ~1h ends in 3:00', style: 'warning' }])
  expect(line({ ...view, now: 61 * MINUTE })[2]).toEqual([{ text: 'cache ~1h elapsed 1m ago', style: 'error' }])
  expect(text(line({ ...view, now: 61 * MINUTE, isWorking: true })).some(section => section.startsWith('cache'))).toBe(false)
})

test('the estimate section shows the phase, bar, percent and the time expected left', () => {
  const estimate = { percent: 85, phase: 'verifying', etaMin: 5, etaMax: 10 }
  expect(text(line({ ...view, progress: estimate }))[2]).toBe('verifying ━━━━━━━━ 85% · 5m–10m')
  expect(line({ ...view, progress: estimate })[2]?.[1]).toEqual({ text: '━━━━━━━', style: 'accent' })
  expect(text(line({ ...view, progress: { ...estimate, etaMin: 90, etaMax: 90 } }))[2]).toBe('verifying ━━━━━━━━ 85% · ~1h30')
  expect(line({ ...view, progress: { percent: 40, phase: 'blocked', etaMin: null, etaMax: null } })[2]?.[1]?.style).toBe('warning')
  expect(text(line({ ...view, progress: { percent: 100, phase: 'complete', etaMin: null, etaMax: null } }))[2]).toBe('complete ━━━━━━━━ 100%')
})

test('the agents row counts the running ones and marks finished and failed', () => {
  const crew = [
    { id: 'a', label: 'Explore', status: 'running', tokens: 42_000 },
    { id: 'b', label: 'reviewer', status: 'completed', tokens: 18_000 },
    { id: 'c', label: 'tester', status: 'failed', tokens: null },
  ]
  expect(agentsLine([], 120)).toEqual([])
  expect(text(agentsLine(crew, 120))).toEqual(['╰ 1 agent running', '● Explore 42k', 'reviewer 18k ✓', 'tester ✗'])
  expect(text(agentsLine(crew, 44))).toEqual(['╰ 1 agent running', '● Explore 42k', '+2'])
  expect(text(agentsLine(crew.map(agent => ({ ...agent, status: 'completed' })), 120))[0]).toBe('╰ agents done')
  expect(agentLabel('caveman:cavecrew-investigator')).toBe('cavecrew-invest…')
})

test('a refused probe is never repeated; a monitor that was not running is asked again later', () => {
  const fresh = { isLinked: false, isRefused: false, probedAt: 0 }
  expect(shouldProbe(fresh, 1)).toBe(true)
  expect(shouldProbe({ ...fresh, probedAt: MINUTE }, 2 * MINUTE)).toBe(false)
  expect(shouldProbe({ ...fresh, probedAt: MINUTE }, MINUTE + PROBE_RETRY_MS)).toBe(true)
  expect(shouldProbe({ ...fresh, isLinked: true, probedAt: MINUTE }, MINUTE + 1)).toBe(true)
  expect(shouldProbe({ isLinked: false, isRefused: true, probedAt: MINUTE }, MINUTE + 10 * PROBE_RETRY_MS)).toBe(false)
})

test('an MCP tool is named the way permission rules spell it', () => {
  expect(toolName('plugin:pomegr:pomegr', 'get_agent_context')).toBe('mcp__plugin_pomegr_pomegr__get_agent_context')
  expect(toolName('pomegr', 'get_agent_context')).toBe('mcp__pomegr__get_agent_context')
})
