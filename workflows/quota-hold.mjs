#!/usr/bin/env node
// One host-local admission-hold map for exhausted provider allowances. Pipeline
// processes record the vendor whose step failed; dispatch reads the map while
// holding the same lock and skips only engines that use an active vendor; the
// operator skill peeks without mutating it.
//
// Writes run under dispatch's host lock and replace the JSON atomically. This
// is deliberately host state, like the usage log and lock files: GitHub cannot
// represent a provider reset shared by every registered repository. A losing
// writer receives that vendor's winning deadline but never another run's
// diagnostic.

import { execFile } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'

export const QUOTA_HOLD_FILE = process.env.EPIC_PROVIDER_HOLD_FILE || resolve(homedir(), 'epic-provider-hold.json')
const LOCK_FILE = resolve(process.env.TMPDIR || tmpdir(), 'harness-dispatch.lock')
const MODULE_FILE = fileURLToPath(import.meta.url)
const FALLBACK_MS = 30 * 60 * 1000

const RESET = /\bresets\s+(1[0-2]|[1-9]):([0-5]\d)\s*(am|pm)\s*\(([^)]+)\)/i

function canonicalInstant(value) {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) return null
  return ms
}

function validateEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provider hold entry must be a JSON object')
  const keys = Object.keys(value).sort().join(',')
  if (keys !== 'fallback,holdUntil,reason') throw new Error('provider hold entry has an invalid schema')
  if (canonicalInstant(value.holdUntil) === null) throw new Error('provider hold entry has an invalid holdUntil')
  if (typeof value.reason !== 'string' || !value.reason.trim()) throw new Error('provider hold entry has an invalid reason')
  if (typeof value.fallback !== 'boolean') throw new Error('provider hold entry has an invalid fallback flag')
  return value
}

function validateMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provider hold must be a JSON object')
  const entries = Object.entries(value)
  if (!entries.length) throw new Error('provider hold map must not be empty')
  for (const [vendor, entry] of entries) {
    if (!vendor.trim() || vendor !== vendor.trim()) throw new Error('provider hold has an invalid vendor key')
    validateEntry(entry)
  }
  return value
}

// #17 wrote one exact four-field record. Accept only that shape as legacy:
// broad coercion would turn damaged state into a launchable admission answer.
function decodeRecord(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === 'fallback,holdUntil,reason,vendor') {
    if (typeof value.vendor !== 'string' || !value.vendor.trim() || value.vendor !== value.vendor.trim()) {
      throw new Error('provider hold has an invalid legacy vendor')
    }
    const { vendor, ...entry } = value
    validateEntry(entry)
    return { records: { [vendor]: entry }, legacy: true }
  }
  return { records: validateMap(value), legacy: false }
}

function wallParts(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return { hour: Number(values.hour), minute: Number(values.minute) }
}

export function deriveQuotaHold(reason, nowMs = Date.now()) {
  const now = Number(nowMs)
  const fallback = () => ({ holdUntil: new Date(now + FALLBACK_MS).toISOString(), fallback: true })
  if (!Number.isFinite(now)) return fallback()
  const match = String(reason || '').match(RESET)
  if (!match) return fallback()

  let hour = Number(match[1]) % 12
  if (match[3].toLowerCase() === 'pm') hour += 12
  const minute = Number(match[2])
  const zone = match[4].trim()
  try {
    // Search absolute minutes rather than hand-rolling zone offsets. It finds
    // the first real future occurrence across UTC, DST gaps/folds and IANA
    // zones using the platform timezone database.
    const firstMinute = Math.floor(now / 60_000) * 60_000
    for (let candidate = firstMinute; candidate <= firstMinute + 8 * 24 * 60 * 60_000; candidate += 60_000) {
      if (candidate <= now) continue
      const wall = wallParts(candidate, zone)
      if (wall.hour === hour && wall.minute === minute) {
        return { holdUntil: new Date(candidate).toISOString(), fallback: false }
      }
    }
  } catch {
    // Invalid provider zones use the bounded fallback below.
  }
  return fallback()
}

async function readRecord() {
  const raw = await readFile(QUOTA_HOLD_FILE, 'utf8')
  let parsed
  try { parsed = JSON.parse(raw) } catch { throw new Error('provider hold is malformed JSON') }
  return decodeRecord(parsed)
}

async function replaceRecord(record) {
  const temp = resolve(dirname(QUOTA_HOLD_FILE), `.${QUOTA_HOLD_FILE.split('/').pop()}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(temp, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temp, QUOTA_HOLD_FILE)
  } catch (error) {
    try { await unlink(temp) } catch { /* no temporary file, or already renamed */ }
    throw error
  }
}

async function recordLocked({ vendor, reason }, nowMs) {
  if (typeof vendor !== 'string' || !vendor.trim()) throw new Error('quota hold vendor is required')
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('quota hold reason is required')
  const vendorName = vendor.trim()
  const derived = deriveQuotaHold(reason, nowMs)
  const candidate = validateEntry({ ...derived, reason: reason.trim() })
  let records = {}
  let legacy = false
  try {
    ;({ records, legacy } = await readRecord())
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const existing = records[vendorName]
  const winner = existing && Date.parse(existing.holdUntil) >= Date.parse(candidate.holdUntil) ? existing : candidate
  if (winner !== existing || legacy) {
    records = { ...records, [vendorName]: winner }
    await replaceRecord(records)
  }
  // Only this vendor's admission timing is shared with the caller. The
  // provider diagnosis belongs to this invocation and may describe another
  // repository, so never return the durable winner's reason to a losing writer.
  return {
    hostHold: { holdUntil: winner.holdUntil, fallback: winner.fallback },
    trigger: { vendor: vendorName, reason: candidate.reason },
  }
}

function validateOutcome(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'hostHold,trigger') {
    throw new Error('provider hold writer returned an invalid outcome')
  }
  const { hostHold, trigger } = value
  if (!hostHold || typeof hostHold !== 'object' || Array.isArray(hostHold) ||
      Object.keys(hostHold).sort().join(',') !== 'fallback,holdUntil' ||
      canonicalInstant(hostHold.holdUntil) === null || typeof hostHold.fallback !== 'boolean') {
    throw new Error('provider hold writer returned invalid host timing')
  }
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger) ||
      Object.keys(trigger).sort().join(',') !== 'reason,vendor' ||
      typeof trigger.vendor !== 'string' || !trigger.vendor.trim() ||
      typeof trigger.reason !== 'string' || !trigger.reason.trim()) {
    throw new Error('provider hold writer returned an invalid trigger')
  }
  return value
}

const execFileResult = (file, args) => new Promise((resolveResult, reject) => {
  execFile(file, args, { maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
    if (error) {
      const detail = String(stderr || stdout || error.message).trim()
      reject(new Error(`could not record provider hold: ${detail}`))
    } else resolveResult(String(stdout || '').trim())
  })
})

export async function recordQuotaHold({ vendor, reason }, { nowMs = Date.now() } = {}) {
  // The child is the critical section: flock stays alive for exactly as long
  // as the read/max/atomic-replace operation, using dispatch's lock path.
  const out = await execFileResult('flock', [
    '-x', LOCK_FILE,
    process.execPath, MODULE_FILE, '_record', String(vendor || ''), String(reason || ''), String(nowMs),
  ])
  let outcome
  try { outcome = JSON.parse(out) } catch { throw new Error('could not record provider hold: writer returned invalid JSON') }
  return validateOutcome(outcome)
}

async function inspect({ clearExpired }) {
  let decoded
  try {
    decoded = await readRecord()
  } catch (error) {
    if (error?.code === 'ENOENT') return { code: 1 }
    return { code: 2, error: error?.message || String(error) }
  }
  const active = Object.fromEntries(Object.entries(decoded.records)
    .filter(([, entry]) => Date.parse(entry.holdUntil) > Date.now()))
  if (!clearExpired) {
    return Object.keys(active).length ? { code: 0, record: active } : { code: 1 }
  }
  try {
    if (!Object.keys(active).length) {
      await unlink(QUOTA_HOLD_FILE)
      return { code: 1 }
    }
    if (decoded.legacy || Object.keys(active).length !== Object.keys(decoded.records).length) {
      await replaceRecord(active)
    }
    return { code: 0, record: active }
  } catch (error) {
    return { code: 2, error: `could not update expired provider holds: ${error?.message || error}` }
  }
}

async function cli() {
  const [command, vendor, reason, now] = process.argv.slice(2)
  if (command === '_record') {
    const record = await recordLocked({ vendor, reason }, Number(now))
    process.stdout.write(`${JSON.stringify(record)}\n`)
    return 0
  }
  if (command !== 'status' && command !== 'peek') {
    process.stderr.write('Usage: quota-hold.mjs status|peek\n')
    return 2
  }
  const result = await inspect({ clearExpired: command === 'status' })
  if (result.record) process.stdout.write(`${JSON.stringify(result.record)}\n`)
  if (result.error) process.stderr.write(`${result.error}\n`)
  return result.code
}

if (process.argv[1] && resolve(process.argv[1]) === MODULE_FILE) {
  try {
    process.exitCode = await cli()
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`)
    process.exitCode = 2
  }
}
