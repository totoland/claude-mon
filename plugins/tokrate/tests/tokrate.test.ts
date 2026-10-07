import { expect, mock, test } from 'claude-code/testing'

const usage = {
  model: 'claude-opus-5-5',
  input_tokens: 10,
  output_tokens: 100,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

test('measures ttft and generation tok/s, shows them and logs a row', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/t' })

  let status: string | undefined
  on('ui.status', ($, e) => {
    status = e.text
    return { value: undefined }
  })
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  on('process.run', ($, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('settings.read', () => ({ value: {} as never }))
  on('session.id', () => ({ value: 'sess-1' }))

  // the "API": first token after 0.8s, done 2s later
  on('turn.step', async function* ($, e) {
    await clock.sleep(800)
    yield { kind: 'text', index: 0, text: 'hi' }
    await clock.sleep(2000)
    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage }
  })

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 })
  const drained = (async () => {
    let step = await stream.next()
    while (!step.done) step = await stream.next()
    return step.value
  })()
  await clock.advance(800)
  await clock.advance(2000)
  const result = await drained
  await clock.settle()

  expect(result.usage?.output_tokens).toBe(100)
  // 100 tokens over 2.0s of generation = 50 tok/s, first token at 0.8s
  expect(status).toContain('⚡ 50 tok/s')
  expect(status).toContain('ttft 0.8s')
  expect(status).toContain('opus-5.5')

  const row = JSON.parse(runs.at(-1)?.stdin ?? '{}')
  expect(runs.at(-1)?.argv.at(-2)).toBe('/home/t/.claude/tokrate')
  expect(row.gen_tok_s).toBe(50)
  expect(row.tok_s).toBe(35.7) // 100 / 2.8s end to end
  expect(row.ttft_s).toBe(0.8)
  expect(row.effort).toBe('medium')
})

test('shows context and rate limits from session.measure', async ($, on) => {
  let status: string | undefined
  on('ui.status', ($, e) => {
    status = e.text
    return { value: undefined }
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { window: 1_000_000, tokens: 60_000, percent: 6 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 29 },
      { kind: 'seven_day', percentUsed: 39.5 },
    ],
    changed: ['context', 'rateLimits'],
  })
  expect(status).toContain('ctx 6%')
  expect(status).toContain('5h 29%')
  expect(status).toContain('7d 40%')
})
