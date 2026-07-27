#!/usr/bin/env node
// Mirrors the production terminal byte-measurement paths at their real budgets: the output
// batcher push and the snapshot budget scan. Every scenario
// asserts which BRANCH of the new arm ran, so a fixture cannot silently stop testing anything.
import { performance } from 'node:perf_hooks'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '../..')
const ITERATIONS = Number(process.env.ORCA_BYTE_LENGTH_BENCH_ITERATIONS ?? '61')
let resultChecksum = 0
let validatedPairs = 0

if (!Number.isSafeInteger(ITERATIONS) || ITERATIONS <= 0) {
  throw new Error(`ORCA_BYTE_LENGTH_BENCH_ITERATIONS must be a positive integer, got ${ITERATIONS}`)
}

function readSource(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

// Re-read the production constants and CALL FORMS so this benchmark fails loudly if the
// code it claims to mirror drifts. Matching call shapes, not bare words.
const FLOW_CONTROL_SOURCE = readSource('src/shared/terminal-multiplex-flow-control.ts')
const TERMINAL_SOURCE = readSource('src/main/runtime/rpc/methods/terminal.ts')
const BYTE_LENGTH_SOURCE = readSource('src/main/runtime/rpc/terminal-stream-byte-length.ts')
const CLIPBOARD_SOURCE = readSource('src/shared/clipboard-text.ts')

function requireConstant(source, name, label) {
  const match = new RegExp(`export const ${name} = ([^\\n]+)`).exec(source)
  if (!match) {
    throw new Error(`${label} is stale: ${name} is no longer exported`)
  }
  const value = Number(new Function(`return (${match[1].trim()})`)())
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is stale: ${name} is not a positive integer`)
  }
  return value
}

function requireCallForm(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`${label} is stale: expected call form \`${needle}\` was not found`)
  }
}

const TERMINAL_OUTPUT_BATCH_MAX_BYTES = requireConstant(
  FLOW_CONTROL_SOURCE,
  'TERMINAL_OUTPUT_BATCH_MAX_BYTES',
  'terminal-multiplex-flow-control'
)
const TERMINAL_STREAM_CHUNK_BYTES = requireConstant(
  FLOW_CONTROL_SOURCE,
  'TERMINAL_STREAM_CHUNK_BYTES',
  'terminal-multiplex-flow-control'
)
const MIN_NATIVE_BYTE_LENGTH_CODE_UNITS = requireConstant(
  BYTE_LENGTH_SOURCE,
  'MIN_NATIVE_BYTE_LENGTH_CODE_UNITS',
  'terminal-stream-byte-length'
)
const REQUESTED_SNAPSHOT_BYTE_BUDGET = (() => {
  const match = /const REQUESTED_SNAPSHOT_BYTE_BUDGET = ([^\n]+)/.exec(TERMINAL_SOURCE)
  if (!match) {
    throw new Error('terminal.ts is stale: REQUESTED_SNAPSHOT_BYTE_BUDGET is gone')
  }
  return Number(new Function(`return (${match[1].trim()})`)())
})()

// The batcher push still measures against a remaining-budget stopAfterBytes.
requireCallForm(TERMINAL_SOURCE, 'measureTerminalStreamByteLength(data, {', 'terminal.ts')
requireCallForm(TERMINAL_SOURCE, 'stopAfterBytes: remainingBudget', 'terminal.ts')
// The snapshot scans still go through the boolean-only exceeds gate.
requireCallForm(
  TERMINAL_SOURCE,
  'terminalStreamByteLengthExceeds(data, REQUESTED_SNAPSHOT_BYTE_BUDGET)',
  'terminal.ts'
)
// The new module still routes the over-limit case back through the legacy partial scan.
requireCallForm(
  BYTE_LENGTH_SOURCE,
  'return measureClipboardTextByteLength(data, options)',
  'terminal-stream-byte-length.ts'
)
requireCallForm(
  BYTE_LENGTH_SOURCE,
  'data.length * MAX_UTF8_BYTES_PER_CODE_UNIT <= (stopAfterBytes as number)',
  'terminal-stream-byte-length.ts'
)
requireCallForm(
  BYTE_LENGTH_SOURCE,
  'data.length >= MIN_NATIVE_BYTE_LENGTH_CODE_UNITS &&',
  'terminal-stream-byte-length.ts'
)
requireCallForm(
  CLIPBOARD_SOURCE,
  'export function measureClipboardTextByteLength(',
  'shared/clipboard-text.ts'
)

// ---- OLD ARM: byte-for-byte copy of shared/clipboard-text.ts measureClipboardTextByteLength,
// which is exactly what terminal.ts called on every one of these paths before the change.
function legacyUtf8ByteLengthForCodePoint(codePoint) {
  if (codePoint <= 0x7f) {
    return 1
  }
  if (codePoint <= 0x7ff) {
    return 2
  }
  if (codePoint <= 0xffff) {
    return 3
  }
  return 4
}

function legacyMeasure(text, options = {}) {
  const stopAfterBytes = options.stopAfterBytes
  let byteLength = 0
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index) ?? 0
    byteLength += legacyUtf8ByteLengthForCodePoint(codePoint)
    if (Number.isFinite(stopAfterBytes) && byteLength > (stopAfterBytes ?? 0)) {
      return { byteLength, exceededLimit: true }
    }
    if (codePoint > 0xffff) {
      index += 1
    }
  }
  return { byteLength, exceededLimit: false }
}

// ---- NEW ARM: mirrors src/main/runtime/rpc/terminal-stream-byte-length.ts, with a branch
// counter so `assertExercised` can prove which path ran instead of guessing from the input.
const MAX_UTF8_BYTES_PER_CODE_UNIT = (() => {
  const match = /const MAX_UTF8_BYTES_PER_CODE_UNIT = (\d+)/.exec(BYTE_LENGTH_SOURCE)
  if (!match) {
    throw new Error('terminal-stream-byte-length.ts is stale: MAX_UTF8_BYTES_PER_CODE_UNIT is gone')
  }
  return Number(match[1])
})()

const BRANCH = { nativeFastPath: 0, scanFallback: 0, lengthShortCircuit: 0 }

function newMeasure(data, options = {}) {
  const stopAfterBytes = options.stopAfterBytes
  if (!Number.isFinite(stopAfterBytes)) {
    BRANCH.nativeFastPath += 1
    return { byteLength: Buffer.byteLength(data, 'utf8'), exceededLimit: false }
  }
  if (
    data.length >= MIN_NATIVE_BYTE_LENGTH_CODE_UNITS &&
    data.length * MAX_UTF8_BYTES_PER_CODE_UNIT <= stopAfterBytes
  ) {
    BRANCH.nativeFastPath += 1
    return { byteLength: Buffer.byteLength(data, 'utf8'), exceededLimit: false }
  }
  BRANCH.scanFallback += 1
  return legacyMeasure(data, options)
}

function newExceeds(data, maxBytes) {
  if (data.length === 0 || !Number.isFinite(maxBytes)) {
    return false
  }
  if (data.length > maxBytes) {
    BRANCH.lengthShortCircuit += 1
    return true
  }
  if (data.length < MIN_NATIVE_BYTE_LENGTH_CODE_UNITS) {
    BRANCH.scanFallback += 1
    return legacyMeasure(data, { stopAfterBytes: maxBytes }).exceededLimit
  }
  BRANCH.nativeFastPath += 1
  return Buffer.byteLength(data, 'utf8') > maxBytes
}

function legacyExceeds(data, maxBytes) {
  return legacyMeasure(data, { stopAfterBytes: maxBytes }).exceededLimit
}

// ---- Fixtures. Deterministic, seeded, and varied per sample so V8 cannot hoist.
function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Realistic agent-TUI output: mostly ASCII with SGR runs, box drawing, and emoji status
// glyphs, plus a per-sample marker so no two measured strings are identical.
function makeTerminalText(codeUnits, sampleId) {
  const random = mulberry32(sampleId * 2654435761)
  const lines = [
    '[35m✻ Thinking…[0m\r\n',
    '  ⏺ Running tests… 42 passed, 0 failed\r\n',
    '│ src/main/runtime/rpc/methods/terminal.ts  │\r\n',
    '  ✅ build succeeded in 12.4s — café naïve\r\n',
    '[32m+ added line[0m\r\n'
  ]
  let text = `sample:${sampleId}\r\n`
  while (text.length < codeUnits) {
    text += lines[Math.floor(random() * lines.length)]
  }
  return text.slice(0, codeUnits)
}

// Keystroke echo and tiny interactive writes: the shapes a PTY emits between key presses.
function makeInteractiveText(codeUnits, sampleId) {
  const random = mulberry32(sampleId * 40503)
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 ./-_'
  let text = ''
  while (text.length < codeUnits) {
    text += alphabet[Math.floor(random() * alphabet.length)]
  }
  return text.slice(0, codeUnits)
}

// Trim to just under a BYTE budget so the legacy arm runs its full scan without tripping the limit.
function makeTerminalTextUnderBytes(byteBudget, sampleId) {
  let text = makeTerminalText(byteBudget, sampleId)
  while (Buffer.byteLength(text, 'utf8') > byteBudget) {
    text = text.slice(0, Math.floor(text.length * (byteBudget / Buffer.byteLength(text, 'utf8'))))
  }
  return text
}

// The TRUE adversary for the exceeds gate: stay at the code-unit cap so `length > maxBytes`
// cannot short-circuit, but pack 3-byte BMP scalars so the legacy scan bails out after only a
// THIRD of the string while Buffer.byteLength still walks all of it.
function makeEarlyTripText(byteBudget, sampleId) {
  const tripUnits = Math.ceil((byteBudget + 1) / MAX_UTF8_BYTES_PER_CODE_UNIT)
  const marker = String.fromCharCode(0x4e00 + (sampleId % 4096))
  const prefix = `${marker}${'走'.repeat(tripUnits - 1)}`
  return `${prefix}${'a'.repeat(byteBudget - tripUnits)}`
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function consume(value) {
  resultChecksum = Math.imul(resultChecksum ^ (value | 0), 16777619) >>> 0
}

// Small inputs are far below timer resolution, so batch them: build `repeats` distinct
// samples, time the whole loop, and report per-call cost. Consuming the running total
// inside the timed region keeps V8 from hoisting the calls out.
function runScenario(scenario) {
  const repeats = scenario.repeats ?? 1
  const samples = { legacy: [], next: [] }
  const runArm = (fn, inputs) => {
    const start = performance.now()
    let total = 0
    for (const input of inputs) {
      total += scenario.checksum(fn(input))
    }
    const elapsed = performance.now() - start
    return { elapsed, total }
  }
  for (let index = 0; index < ITERATIONS; index += 1) {
    // Alternate which arm leads on every iteration so cache/JIT warmup is shared evenly.
    for (const legacyFirst of index % 2 === 0 ? [true, false] : [false, true]) {
      const batch = index * 2 + (legacyFirst ? 0 : 1)
      const inputs = []
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        inputs.push(scenario.make(batch * repeats + repeat))
      }
      for (const input of inputs) {
        const legacyOutput = scenario.legacy(input)
        const branchBefore = { ...BRANCH }
        const nextOutput = scenario.next(input)
        if (!scenario.equal(legacyOutput, nextOutput)) {
          throw new Error(
            `${scenario.label}: arms disagree on ${JSON.stringify(input.slice(0, 40))}`
          )
        }
        scenario.assertExercised(legacyOutput, input, {
          nativeFastPath: BRANCH.nativeFastPath - branchBefore.nativeFastPath,
          scanFallback: BRANCH.scanFallback - branchBefore.scanFallback,
          lengthShortCircuit: BRANCH.lengthShortCircuit - branchBefore.lengthShortCircuit
        })
        validatedPairs += 1
      }
      let legacyResult
      let nextResult
      if (legacyFirst) {
        legacyResult = runArm(scenario.legacy, inputs)
        nextResult = runArm(scenario.next, inputs)
      } else {
        nextResult = runArm(scenario.next, inputs)
        legacyResult = runArm(scenario.legacy, inputs)
      }
      consume(legacyResult.total)
      consume(nextResult.total)
      samples.legacy.push(legacyResult.elapsed / repeats)
      samples.next.push(nextResult.elapsed / repeats)
    }
  }
  return { legacy: median(samples.legacy), next: median(samples.next) }
}

const measurementEqual = (a, b) =>
  a.byteLength === b.byteLength && a.exceededLimit === b.exceededLimit
const measurementChecksum = (m) => m.byteLength + (m.exceededLimit ? 1 : 0)
const booleanChecksum = (value) => (value ? 1 : 0)

// Every scenario must state which branch it is testing. `expectBranch` is checked on EVERY
// sample against a live counter inside the new arm, so a fixture that stops reaching the
// branch it claims to exercise fails the benchmark instead of quietly reporting 1.00x.
function requireBranch(expected) {
  return (counts) => {
    if (counts[expected] !== 1) {
      throw new Error(
        `expected the ${expected} branch to run exactly once, got ${JSON.stringify(counts)}`
      )
    }
  }
}

const batchScenario = (label, make, options = {}) => ({
  label,
  make,
  repeats: options.repeats,
  legacy: (input) => legacyMeasure(input, { stopAfterBytes: TERMINAL_OUTPUT_BATCH_MAX_BYTES }),
  next: (input) => newMeasure(input, { stopAfterBytes: TERMINAL_OUTPUT_BATCH_MAX_BYTES }),
  equal: measurementEqual,
  checksum: measurementChecksum,
  assertExercised: (out, input, counts) => {
    options.assert?.(out, input)
    requireBranch(options.branch)(counts)
  }
})

const gateScenario = (label, budget, make, options = {}) => ({
  label,
  make,
  repeats: options.repeats,
  legacy: (input) => legacyExceeds(input, budget),
  next: (input) => newExceeds(input, budget),
  equal: (a, b) => a === b,
  checksum: booleanChecksum,
  assertExercised: (out, input, counts) => {
    options.assert?.(out, input)
    requireBranch(options.branch)(counts)
  }
})

const scenarios = [
  batchScenario('batcher push 8KiB', (sampleId) => makeTerminalText(8 * 1024, sampleId), {
    branch: 'nativeFastPath',
    assert: (out) => {
      if (out.exceededLimit) {
        throw new Error('batcher push 8KiB should stay under the batch budget')
      }
    }
  }),
  batchScenario(
    'batcher push over budget',
    // Oversized on purpose: this is the case where the arms MUST both return the partial count.
    (sampleId) => makeTerminalText(3 * TERMINAL_OUTPUT_BATCH_MAX_BYTES, sampleId),
    {
      branch: 'scanFallback',
      assert: (out) => {
        if (!out.exceededLimit) {
          throw new Error('over-budget fixture never exceeded the limit')
        }
      }
    }
  ),
  // TRUE WORST CASE for the batcher push. The guard only takes the native count when
  // length*3 <= stopAfterBytes, which PROVES the limit cannot trip, so the fast path can never
  // pay for both a Buffer.byteLength and a scan. What is left is the shape where the native
  // call replaces the fewest scan iterations: a chunk sitting just above the code-unit floor.
  batchScenario(
    `batcher push ${MIN_NATIVE_BYTE_LENGTH_CODE_UNITS}B (floor)`,
    (sampleId) => makeInteractiveText(MIN_NATIVE_BYTE_LENGTH_CODE_UNITS, sampleId),
    { branch: 'nativeFastPath', repeats: 4096 }
  ),
  // Below the floor the new arm deliberately keeps the scan, so it is the legacy code exactly.
  batchScenario('batcher push 4B keystroke', (sampleId) => makeInteractiveText(4, sampleId), {
    branch: 'scanFallback',
    repeats: 4096
  }),
  gateScenario(
    `snapshot scan ${(REQUESTED_SNAPSHOT_BYTE_BUDGET / (1024 * 1024)).toFixed(0)}MiB`,
    REQUESTED_SNAPSHOT_BYTE_BUDGET,
    (sampleId) => makeTerminalTextUnderBytes(REQUESTED_SNAPSHOT_BYTE_BUDGET, sampleId),
    {
      branch: 'nativeFastPath',
      assert: (out) => {
        if (out) {
          throw new Error('snapshot fixture should sit under the budget so the full scan runs')
        }
      }
    }
  ),
  // TRUE WORST CASE for the boolean gate: at the code-unit cap so `length > maxBytes` cannot
  // short-circuit, but 3-byte scalars let the legacy scan bail out a THIRD of the way in while
  // Buffer.byteLength still walks the whole string. This is where the new arm can actually lose.
  gateScenario(
    'snapshot gate early-trip',
    REQUESTED_SNAPSHOT_BYTE_BUDGET,
    (sampleId) => makeEarlyTripText(REQUESTED_SNAPSHOT_BYTE_BUDGET, sampleId),
    {
      branch: 'nativeFastPath',
      assert: (out, input) => {
        if (!out) {
          throw new Error('early-trip gate fixture must exceed the budget')
        }
        if (input.length > REQUESTED_SNAPSHOT_BYTE_BUDGET) {
          throw new Error('early-trip fixture must not hit the code-unit short circuit')
        }
      }
    }
  ),
  gateScenario(
    'chunk gate early-trip',
    TERMINAL_STREAM_CHUNK_BYTES,
    (sampleId) => makeEarlyTripText(TERMINAL_STREAM_CHUNK_BYTES, sampleId),
    {
      branch: 'nativeFastPath',
      assert: (out, input) => {
        if (!out) {
          throw new Error('early-trip chunk fixture must exceed the budget')
        }
        if (input.length > TERMINAL_STREAM_CHUNK_BYTES) {
          throw new Error('early-trip fixture must not hit the code-unit short circuit')
        }
      }
    }
  ),
  gateScenario(
    `chunk gate ${TERMINAL_STREAM_CHUNK_BYTES / 1024}KiB`,
    TERMINAL_STREAM_CHUNK_BYTES,
    (sampleId) => makeTerminalTextUnderBytes(TERMINAL_STREAM_CHUNK_BYTES, sampleId),
    {
      branch: 'nativeFastPath',
      assert: (out) => {
        if (out) {
          throw new Error('chunk gate fixture should sit under the chunk budget')
        }
      }
    }
  )
]

const pad = (value, width) => String(value).padStart(width)
const formatTime = (ms) =>
  ms >= 0.001 ? `${(ms * 1000).toFixed(1)} us` : `${(ms * 1e6).toFixed(1)} ns`
console.log('Production terminal byte-measurement paths. Lower is better.')
console.log(
  `iterations=${ITERATIONS} (${ITERATIONS * 2} counterbalanced batches/scenario, per-arm medians)`
)
console.log(`${pad('scenario', 30)} ${pad('legacy', 12)} ${pad('new', 12)} ${pad('speedup', 9)}`)
for (const scenario of scenarios) {
  const { legacy, next } = runScenario(scenario)
  console.log(
    `${pad(scenario.label, 30)} ${pad(formatTime(legacy), 12)} ${pad(formatTime(next), 12)} ${pad(`${(legacy / next).toFixed(2)}x`, 9)}`
  )
}

// Small-chunk sweep across real interactive PTY write sizes. The floor makes everything below
// MIN_NATIVE_BYTE_LENGTH_CODE_UNITS byte-identical to the legacy scan, so those rows must land
// at ~1.00x; anything materially below that is a regression the change would be shipping.
{
  console.log(
    `\nbatcher push small-chunk sweep (stopAfterBytes=${TERMINAL_OUTPUT_BATCH_MAX_BYTES}):`
  )
  console.log(
    `${pad('bytes', 10)} ${pad('legacy', 12)} ${pad('new', 12)} ${pad('speedup', 9)}  branch`
  )
  for (const codeUnits of [4, 8, 16, 64, 256, 1024, 4096]) {
    const before = { ...BRANCH }
    const { legacy, next } = runScenario(
      batchScenario(`sweep ${codeUnits}`, (sampleId) => makeInteractiveText(codeUnits, sampleId), {
        branch: codeUnits >= MIN_NATIVE_BYTE_LENGTH_CODE_UNITS ? 'nativeFastPath' : 'scanFallback',
        repeats: Math.max(64, Math.min(4096, Math.ceil(2 ** 18 / codeUnits)))
      })
    )
    const branch = BRANCH.nativeFastPath > before.nativeFastPath ? 'native' : 'scan (unchanged)'
    console.log(
      `${pad(`${codeUnits} B`, 10)} ${pad(formatTime(legacy), 12)} ${pad(formatTime(next), 12)} ${pad(`${(legacy / next).toFixed(2)}x`, 9)}  ${branch}`
    )
  }
}

console.log(
  `\nvalidated=${validatedPairs} measured pairs, branches=${JSON.stringify(BRANCH)}, result checksum=${resultChecksum >>> 0}`
)
