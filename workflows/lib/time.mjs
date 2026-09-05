// One formatter for timestamps a human reads in pane logs and GitHub status
// comments. HOST_TIMEZONE is normally validated by etc/lib.sh and explicitly
// passed into tmux panes by launch.sh; standalone Node runs still fail closed
// here. Machine records keep their call-site toISOString() clocks.
import { readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const ZONE_ROOT = '/usr/share/zoneinfo'
const SAFE_ZONE = /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/
const ADMIN_ZONE_ENTRIES = new Set(['localtime', 'posixrules'])

function invalidZone(zone) {
  return new Error(`HOST_TIMEZONE must name a known, safe IANA zone, got '${zone}'`)
}

function hostZone() {
  const zone = process.env.HOST_TIMEZONE || 'UTC'
  if (
    !SAFE_ZONE.test(zone) ||
    `/${zone}/`.includes('/../') ||
    `/${zone}/`.includes('/./') ||
    ADMIN_ZONE_ENTRIES.has(zone) ||
    zone.startsWith('posix/') ||
    zone.startsWith('right/')
  ) {
    throw invalidZone(zone)
  }
  try {
    if (!statSync(`${ZONE_ROOT}/${zone}`).isFile()) throw new Error('not a file')
    if (readFileSync(`${ZONE_ROOT}/${zone}`).subarray(0, 4).toString('ascii') !== 'TZif') {
      throw new Error('not TZif data')
    }
  } catch {
    throw invalidZone(zone)
  }
  return zone
}

function epochSeconds(instant) {
  const millis = instant instanceof Date
    ? instant.getTime()
    : typeof instant === 'number'
      ? instant
      : Date.parse(instant)
  if (!Number.isFinite(millis)) throw new Error(`invalid timestamp: ${instant}`)
  return Math.floor(millis / 1000)
}

function runDate(args, zone) {
  return spawnSync('date', args, {
    encoding: 'utf8',
    env: { ...process.env, TZ: zone, LC_ALL: 'C' },
  })
}

export function humanTimestamp(instant = Date.now()) {
  const zone = hostZone()
  const seconds = epochSeconds(instant)
  const format = '+%Y-%m-%d %H:%M:%S %Z'
  let result = runDate(['-d', `@${seconds}`, format], zone)
  if (result.status !== 0) result = runDate(['-r', String(seconds), format], zone)
  if (result.status !== 0 || result.error) {
    throw new Error(`could not render timestamp in HOST_TIMEZONE=${zone}`)
  }
  return result.stdout.trim()
}

const MACHINE_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b/g

function canonicalMachineInstant(value) {
  const millis = Date.parse(value)
  if (!Number.isFinite(millis)) return false
  return new Date(millis).toISOString() === (value.includes('.') ? value : value.replace(/Z$/, '.000Z'))
}

// Machine records retain their original values; callers opt into this only
// while composing prose for a human. Invalid lookalikes are left as written,
// while an invalid HOST_TIMEZONE still fails through humanTimestamp().
export function humanizeTimestamps(value) {
  return String(value).replace(MACHINE_INSTANT, instant =>
    canonicalMachineInstant(instant) ? humanTimestamp(instant) : instant)
}
