import { expect, test } from 'claude-code/testing'

test('the line draws above the prompt and leaves the hint to the engine', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'pomegr',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
      viewport: { columns: 120, rows: 40 },
    })
    expect(await band.find({ type: 'Text', text: /◆/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Pomegr/ })).toBe(undefined)
    expect(await band.find({ type: 'Text', text: /running/ })).toBe(undefined)
    await band.unmount()
  }
})

test('/pomegr-hud moves the line under the hint', async $ => {
  await $.command.run({ command: 'pomegr-hud', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as Parameters<typeof $.command.run>[0])
  const hint = await $.ui.mount({
    plugin: 'pomegr',
    surface: 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
    viewport: { columns: 120, rows: 40 },
  })
  expect(await hint.find({ type: 'Text', text: /for shortcuts/ })).toBeDefined()
  expect(await hint.find({ type: 'Text', text: /◆/ })).toBeDefined()
  await hint.unmount()
})
