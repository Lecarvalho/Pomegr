import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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
  const inlineMap = trimmed.match(/^\{\s*([^:]+):\s*([^}]+)\s*\}$/)
  if (inlineMap) return { [inlineMap[1].trim()]: scalar(inlineMap[2]) }
  return trimmed
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

test('ACOS harness profiles resolve to compatible native provider tiers', async () => {
  const [configSource, catalogSource] = await Promise.all([
    readFile(path.join(root, '.acos.yaml'), 'utf8'),
    readFile(path.join(root, 'acos/catalog/providers.yaml'), 'utf8'),
  ])
  const config = parseYaml(configSource)
  const catalog = parseYaml(catalogSource)

  assert.deepEqual(Object.keys(config.harnesses).sort(), ['claude', 'codex'])
  assert.equal(config.provider, undefined)
  assert.equal(config.models, undefined)
  assert.equal(config.startup, undefined)
  assert.equal(typeof config.verify, 'string')
  assert.equal(typeof config.shot, 'string')
  assert.ok(config.limits)
  assert.ok(config.gates)

  for (const [harness, profile] of Object.entries(config.harnesses)) {
    assert.ok(config.providers.includes(profile.provider), `${harness} selects a listed provider`)
    const provider = catalog.providers[profile.provider]
    assert.ok(provider, `${harness} provider exists in the catalog`)
    for (const tier of ['fast', 'balanced', 'strong']) {
      const model = provider.models[profile.models[tier]]
      assert.ok(model, `${harness} ${tier} model exists in its provider catalog`)
      assert.equal(model.tier, tier, `${harness} ${tier} model has the matching catalog tier`)
    }
    assert.equal(provider.invoke.inline.native_harness, harness)
    assert.equal(provider.invoke.subagent.native_harness, harness)
    assert.equal(typeof profile.startup.orchestrator, 'number')
    assert.equal(typeof profile.startup.subagent, 'number')
    assert.equal(typeof profile.startup.basis, 'string')
  }

  assert.equal(catalog.providers.anthropic.invoke.workflow.native_harness, 'claude')
  assert.equal(catalog.providers.openai.invoke.workflow, null)
  assert.match(catalog.providers.openai.invoke.external, /model_reasoning_effort=\{\{effort\}\}/)
  assert.equal(catalog.providers.openai.effort_map.max, 'max')
})

test('ACOS operating files do not point to absent local specifications', async () => {
  const files = [
    '.agents/skills/acos/SKILL.md',
    'acos/catalog/blocks/implement.yaml',
    'acos/catalog/blocks/plan.yaml',
  ]
  const danglingLocalFile = /(?:SPEC\.md|schema\/acos\.schema\.json|install\.md)/
  for (const file of files) {
    const content = await readFile(path.join(root, file), 'utf8')
    assert.doesNotMatch(content, danglingLocalFile, `${file} must be self-contained`)
  }
})
