import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

// Per API response (turn.step), measured live rather than parsed from the transcript:
//   ttft   = first streamed chunk - request start
//   gen    = output_tokens / (end - first chunk)   -> pure generation speed
//   e2e    = output_tokens / (end - request start) -> what you actually wait for
const WINDOW = 10      // responses in avg + sparkline
const MIN_TOKENS = 20  // tiny responses are noise
const SPARK = '▁▂▃▄▅▆▇█'
const LOG_FILE = 'log.jsonl' // under $HOME/.claude/tokrate, same format statusline.py --report reads

type Sample = { gen: number; e2e: number; ttft: number; out: number; genSecs: number }

// Module state resets on hot reload; that only costs the sparkline history.
let samples: Sample[] = []
let ctxPercent: number | undefined
let limits: SessionRateLimit[] = []
let modelName: string | undefined

const pct = (p: number | undefined) => (p === undefined ? '--' : `${Math.round(p)}%`)

function spark(vals: number[]) {
  if (vals.length === 0) return ''
  const lo = Math.min(...vals)
  const span = Math.max(...vals) - lo || 1
  return vals.map(v => SPARK[Math.floor(((v - lo) / span) * (SPARK.length - 1))]).join('')
}

function shortModel(id: string) {
  // claude-opus-5-5 -> opus-5.5
  const m = id.replace(/^claude-/, '').match(/^([a-z]+)-(\d+)-(\d+)/)
  return m ? `${m[1]}-${m[2]}.${m[3]}` : id
}

function paint($: EngineInterface) {
  const parts: string[] = []
  if (modelName) parts.push(modelName)
  parts.push(`ctx ${pct(ctxPercent)}`)
  for (const [label, kind] of [['5h', 'five_hour'], ['7d', 'seven_day']] as const) {
    const w = limits.find(l => l.kind === kind)
    if (w) parts.push(`${label} ${pct(w.percentUsed)}`)
  }
  const last = samples.at(-1)
  if (last) {
    // weighted avg = total tokens / total generation time
    const avg = samples.reduce((a, s) => a + s.out, 0) / samples.reduce((a, s) => a + s.genSecs, 0)
    parts.push(
      `⚡ ${Math.round(last.gen)} tok/s · ttft ${last.ttft.toFixed(1)}s · avg ${Math.round(avg)} ${spark(samples.map(s => s.gen))}`,
    )
  } else {
    parts.push('⚡ -- tok/s')
  }
  $.ui.status(parts.join(' │ '))
}

async function logDir($: EngineInterface) {
  const home = await $.env.get('HOME')
  return home ? `${home}/.claude/tokrate` : undefined
}

async function appendLog($: EngineInterface, row: Record<string, unknown>) {
  const dir = await logDir($)
  if (!dir) return
  // sh `>>` is an O_APPEND write: safe with several sessions logging at once
  await $.process.run(['sh', '-c', 'mkdir -p "$1" && cat >> "$1/$2"', 'sh', dir, LOG_FILE], {
    stdin: JSON.stringify(row) + '\n',
  })
}

function pctl(vals: number[], q: number) {
  const s = [...vals].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0
}

type Row = { ts: string; model: string; output_tokens: number; duration_s: number; tok_s: number; gen_tok_s?: number; ttft_s?: number; effort?: string; fast_mode?: boolean }

function report(rows: Row[]) {
  const out: string[] = [`${rows.length} responses  ${rows[0]!.ts} → ${rows.at(-1)!.ts}`]
  const table = (title: string, key: (r: Row) => string) => {
    const groups = new Map<string, Row[]>()
    for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r])
    out.push('', title, `  ${'group'.padEnd(26)}${'n'.padStart(6)}${'gen'.padStart(7)}${'e2e'.padStart(7)}${'p10'.padStart(7)}${'p90'.padStart(7)}${'ttft'.padStart(7)}`)
    for (const [k, g] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      // older rows (from statusline.py) have no gen/ttft: fall back to e2e
      const gen = g.map(r => r.gen_tok_s ?? r.tok_s)
      const e2e = g.reduce((a, r) => a + r.output_tokens, 0) / g.reduce((a, r) => a + r.duration_s, 0)
      const ttfts = g.flatMap(r => (r.ttft_s === undefined ? [] : [r.ttft_s]))
      out.push(
        `  ${k.slice(0, 25).padEnd(26)}${String(g.length).padStart(6)}${Math.round(pctl(gen, 0.5)).toString().padStart(7)}` +
          `${Math.round(e2e).toString().padStart(7)}${Math.round(pctl(gen, 0.1)).toString().padStart(7)}` +
          `${Math.round(pctl(gen, 0.9)).toString().padStart(7)}${(ttfts.length ? pctl(ttfts, 0.5).toFixed(1) + 's' : '--').padStart(7)}`,
      )
    }
  }
  table('by model', r => r.model)
  table('by model + effort', r => `${shortModel(r.model)} / ${r.effort ?? '?'}`)
  table('by fast mode', r => `fast=${r.fast_mode ?? '?'}`)
  table('by hour (local)', r => `${r.ts.slice(11, 13)}:00`)
  table('by day', r => r.ts.slice(0, 10))
  out.push('', 'gen = median generation tok/s · e2e = tokens / total wait · ttft = median time to first token')
  return '```\n' + out.join('\n') + '\n```'
}

function localIso(ms: number) {
  const d = new Date(ms)
  const off = -d.getTimezoneOffset()
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const local = new Date(ms + off * 60_000).toISOString().slice(0, 19)
  return `${local}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tokrate',
      description: 'Token throughput report (by model, effort, fast mode, hour, day)',
    })
    const usage = await $.session.usage()
    ctxPercent = usage.context.percent
    limits = usage.rateLimits
    paint($)
    return next(e)
  })

  on('session.measure', ($, e, next) => {
    ctxPercent = e.context.percent
    limits = e.rateLimits
    paint($)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const start = await $.clock.now()
    let first: number | undefined
    const stream = next(e)
    for await (const chunk of stream) {
      if (first === undefined && chunk.kind !== 'engine' && chunk.kind !== 'stop') first = await $.clock.now()
      yield chunk
    }
    const result = await stream.result
    const end = await $.clock.now()

    const usage = result.usage
    if (!usage || first === undefined || usage.output_tokens < MIN_TOKENS) return result
    const genSecs = Math.max((end - first) / 1000, 0.05)
    const totalSecs = (end - start) / 1000
    const s: Sample = {
      gen: usage.output_tokens / genSecs,
      e2e: usage.output_tokens / totalSecs,
      ttft: (first - start) / 1000,
      out: usage.output_tokens,
      genSecs,
    }

    if (!e.agentId) {
      // the status line follows the main conversation only
      modelName = shortModel(usage.model)
      samples = [...samples, s].slice(-WINDOW)
      paint($)
    }

    const settings = await $.settings.read().catch(() => undefined)
    void appendLog($, {
      ts: localIso(end),
      model: usage.model,
      output_tokens: usage.output_tokens,
      duration_s: +totalSecs.toFixed(3),
      tok_s: +s.e2e.toFixed(1),
      gen_tok_s: +s.gen.toFixed(1),
      ttft_s: +s.ttft.toFixed(3),
      effort: typeof e.effort === 'string' ? e.effort : undefined,
      fast_mode: (settings as { fastMode?: boolean } | undefined)?.fastMode,
      agent_id: e.agentId,
      session_id: await $.session.id().catch(() => undefined),
      source: 'tokrate-plugin',
    }).catch(() => undefined)

    return result
  })

  on('command.run', { command: 'tokrate' }, async $ => {
    const dir = await logDir($)
    const text = dir ? await $.fs.read(`${dir}/${LOG_FILE}`).catch(() => '') : ''
    const rows = String(text)
      .split('\n')
      .flatMap(l => {
        try {
          return l ? [JSON.parse(l) as Row] : []
        } catch {
          return []
        }
      })
    return { text: rows.length ? report(rows) : 'No responses logged yet.' }
  })
}
