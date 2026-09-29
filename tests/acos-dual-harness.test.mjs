import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skill = '.agents/skills/acos'

function stripComment(line) {
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if ((character === '"' || character === "'") && line[index - 1] !== '\\') {
      quote = quote === character ? null : (quote ?? character)
    } else if (character === '#' && quote === null) {
      return line.slice(0, index)
    }
  }
  return line
}

function splitFlow(body) {
  const parts = []
  let depth = 0
  let current = ''
  for (const character of body) {
    if (character === '[' || character === '{') depth += 1
    if (character === ']' || character === '}') depth -= 1
    if (character === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += character
    }
  }
  if (current.trim() !== '') parts.push(current)
  return parts
}

function scalar(value) {
  const trimmed = value.trim()
  if (trimmed === 'null') return null
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return splitFlow(trimmed.slice(1, -1)).map(scalar)
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return Object.fromEntries(splitFlow(trimmed.slice(1, -1)).map((entry) => {
      const separator = entry.indexOf(':')
      return [entry.slice(0, separator).trim(), scalar(entry.slice(separator + 1))]
    }))
  }
  return trimmed
}

function stripComments(source) {
  return source.split(/\r?\n/).map(stripComment).join('\n')
}

function parseYaml(source) {
  const lines = source.split(/\r?\n/)
    .map((line) => stripComment(line).replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '')
    .map((line) => ({ indent: line.match(/^ */)[0].length, text: line.trim() }))

  function block(position, indent) {
    const list = lines[position]?.indent === indent && lines[position].text.startsWith('- ')
    const result = list ? [] : {}
    let cursor = position
    while (cursor < lines.length && lines[cursor].indent === indent) {
      const current = lines[cursor]
      if (list) {
        assert.ok(current.text.startsWith('- '), `mixed YAML collection at ${current.text}`)
        result.push(scalar(current.text.slice(2)))
        cursor += 1
        continue
      }
      assert.ok(!current.text.startsWith('- '), `mixed YAML collection at ${current.text}`)
      const separator = current.text.indexOf(':')
      assert.ok(separator > 0, `invalid YAML mapping entry: ${current.text}`)
      const key = current.text.slice(0, separator).trim()
      const value = current.text.slice(separator + 1).trim()
      cursor += 1
      if (value !== '') {
        result[key] = scalar(value)
      } else if (cursor < lines.length && lines[cursor].indent > indent) {
        const nested = block(cursor, lines[cursor].indent)
        result[key] = nested.value
        cursor = nested.cursor
      } else {
        result[key] = null
      }
    }
    return { value: result, cursor }
  }

  return block(0, 0).value
}

test('ACOS harness profiles resolve to catalog tiers without model ids', async () => {
  const [configSource, catalogSource] = await Promise.all([
    readFile(path.join(root, skill, 'config.yaml'), 'utf8'),
    readFile(path.join(root, skill, 'catalog/providers.yaml'), 'utf8'),
  ])
  const config = parseYaml(configSource)
  const catalog = parseYaml(catalogSource)

  assert.doesNotMatch(stripComments(configSource), /claude-|gpt-/, 'config.yaml names tiers, never model ids')
  assert.equal(config.models, undefined)
  assert.equal(typeof config.verify, 'string')
  assert.equal(typeof config.shot, 'string')
  assert.ok(config.limits)
  assert.ok(config.gates)

  const profiles = {
    claude: { provider: config.provider, startup: config.startup },
    ...config.harnesses,
  }
  assert.deepEqual(Object.keys(profiles).sort(), ['claude', 'codex'])

  for (const [harness, profile] of Object.entries(profiles)) {
    assert.equal(profile.models, undefined, `${harness} names no model ids`)
    assert.ok(config.providers.includes(profile.provider), `${harness} selects a listed provider`)
    const provider = catalog.providers[profile.provider]
    assert.ok(provider, `${harness} provider exists in the catalog`)
    for (const tier of ['fast', 'balanced', 'strong']) {
      assert.equal(typeof provider.tiers[tier]?.alias, 'string', `${harness} ${tier} tier has an alias`)
    }
    assert.equal(typeof profile.startup.orchestrator, 'number')
    assert.equal(typeof profile.startup.subagent, 'number')
    assert.equal(typeof profile.startup.basis, 'string')
  }

  assert.match(catalog.providers.openai.invoke.external, /model_reasoning_effort=\{\{effort\}\}/)
})

test('ACOS operating files do not point to absent local specifications', async () => {
  const files = [
    `${skill}/SKILL.md`,
    `${skill}/catalog/blocks/implement.yaml`,
    `${skill}/catalog/blocks/plan.yaml`,
  ]
  const danglingLocalFile = /(?:SPEC\.md|schema\/acos\.schema\.json|install\.md)/
  for (const file of files) {
    const content = await readFile(path.join(root, file), 'utf8')
    assert.doesNotMatch(content, danglingLocalFile, `${file} must be self-contained`)
  }
})
