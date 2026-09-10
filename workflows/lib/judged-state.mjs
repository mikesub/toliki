// Independent proof that a judging model left both code and protected Git
// state unchanged. The model's read-only charter/sandbox is the first boundary;
// this complete before/after snapshot is the fail-closed backstop.

import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { git, worktreeTree } from './repo.mjs'

function filesystemDigest(roots) {
  const hash = createHash('sha256')
  const visit = file => {
    let stat
    try { stat = lstatSync(file) } catch (error) {
      if (error.code === 'ENOENT') { hash.update(`missing\0${file}\0`); return }
      throw error
    }
    hash.update(`${file}\0${stat.mode}\0`)
    if (stat.isSymbolicLink()) { hash.update(`link\0${readlinkSync(file)}\0`); return }
    if (stat.isDirectory()) {
      hash.update('dir\0')
      for (const entry of readdirSync(file).sort()) visit(path.join(file, entry))
      return
    }
    if (stat.isFile()) { hash.update('file\0'); hash.update(readFileSync(file)); return }
    hash.update('other\0')
  }
  for (const root of roots) visit(root)
  return hash.digest('hex')
}

// A real tree of the complete worktree plus everything that can change how a
// later deterministic Git command interprets it. Returns null when any part is
// unreadable; an invariant that cannot be checked has not held.
export async function judgedState() {
  const head = await git(['rev-parse', 'HEAD'])
  if (!head.ok) return null
  const indexPath = await git(['rev-parse', '--git-path', 'index'])
  const config = await git(['config', '--null', '--show-origin', '--list'])
  const common = await git(['rev-parse', '--git-common-dir'])
  if (!indexPath.ok || !config.ok || !common.ok) return null
  const commonDir = path.resolve(process.cwd(), common.out)
  const realIndex = path.resolve(process.cwd(), indexPath.out)
  const tree = await worktreeTree()
  if (tree === null) return null
  let metadata
  try {
    metadata = filesystemDigest([
      path.join(commonDir, 'hooks'),
      path.join(commonDir, 'refs', 'replace'),
      path.join(commonDir, 'info', 'grafts'),
    ])
  } catch { return null }
  let index
  try { index = filesystemDigest([realIndex]) } catch { return null }
  return { head: head.out, tree, index, config: config.out, metadata }
}

// Why a judging phase must block, or null when it left the exact protected
// state alone. `what` names the phase in the operator-facing diagnostic.
export async function readOnlyViolation(before, what) {
  const after = await judgedState()
  if (!before || !after) {
    return `the worktree could not be read around ${what} — refusing to ship bytes when that phase cannot be shown to have left them alone.`
  }
  if (before.head === after.head && before.tree === after.tree &&
      before.index === after.index && before.config === after.config &&
      before.metadata === after.metadata) return null
  const touched = await git(['diff', '--name-only', before.tree, after.tree])
  const detail = [
    touched.ok && touched.out ? `touched ${touched.out.split('\n').join(', ')}` : null,
    before.head === after.head ? null : `moved HEAD ${before.head.slice(0, 7)} → ${after.head.slice(0, 7)}`,
    before.index === after.index ? null : 'changed the Git index',
    before.config === after.config ? null : 'changed Git configuration',
    before.metadata === after.metadata ? null : 'changed hooks or ancestry metadata',
  ].filter(Boolean).join('; ') || 'the worktree tree hash changed'
  return `${what} changed the tree it was judging (${detail}) — that phase is read-only under every engine, and an edit it makes is neither reviewed nor verified. Refusing to fold it into the shipment.`
}
