#!/usr/bin/env node

// Laptop setup only: register spec-explorer's real charter path in Codex's user
// config. Codex 0.153.4 discovers the agent symlink but refuses it when applying
// the role (ELOOP), so discovery alone cannot prove it is launchable. Register
// the role directly; the caller then removes its obsolete discovery symlink,
// since keeping both definitions makes Codex report a duplicate role.
//
// Codex's config API owns TOML parsing and editing; no second parser or model
// call. Preserve foreign roles, compare the user-config version before writing,
// and read the result back. The entire exchange has one bounded deadline.

import { spawn } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const [configArg, charterArg] = process.argv.slice(2);
let child;
let deadline;
let lines;
try {
  if (!configArg || !charterArg) throw new Error('expected user config and charter paths');
  const configPath = resolve(configArg);
  const charterPath = realpathSync(charterArg);
  const configStat = lstatSync(configPath, { throwIfNoEntry: false });
  if (configStat && !configStat.isFile()) {
    throw new Error(`${configPath} is not a regular file — resolve by hand`);
  }

  child = spawn('codex', ['app-server', '--stdio'], {
    cwd: dirname(dirname(configPath)),
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map();
  let nextId = 0;
  const fail = error => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  child.on('error', () => fail(new Error('could not start codex app-server')));
  child.on('exit', () => fail(new Error('codex app-server exited before config registration completed')));
  child.stdin.on('error', () => fail(new Error('could not write to codex app-server')));
  const interrupted = () => {
    child.kill('SIGTERM');
    fail(new Error('Codex config registration interrupted'));
  };
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let reply;
    try { reply = JSON.parse(line); }
    catch { fail(new Error('codex app-server returned malformed JSON')); return; }
    const waiting = pending.get(reply.id);
    if (!waiting) return;
    pending.delete(reply.id);
    if (reply.error) waiting.reject(new Error(`Codex ${waiting.method} refused the request; configuration was not confirmed`));
    else waiting.resolve(reply.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  deadline = setTimeout(() => {
    fail(new Error('Codex config registration timed out after 15 seconds'));
    child.kill('SIGKILL');
  }, 15_000);

  await request('initialize', { clientInfo: { name: 'toliki-setup', version: '1' } });
  child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  const readUser = async () => {
    const reply = await request('config/read', { includeLayers: true, cwd: dirname(dirname(configPath)) });
    const users = reply?.layers?.filter(layer => layer.name?.type === 'user');
    if (users?.length !== 1 || users[0].name.file !== configPath || !users[0].version ||
        typeof users[0].version !== 'string' || !users[0].config ||
        typeof users[0].config !== 'object' || Array.isArray(users[0].config)) {
      throw new Error(`Codex did not return the user-config version for ${configPath}`);
    }
    return users[0];
  };
  const before = await readUser();
  const role = before.config?.agents?.['spec-explorer'];
  const previous = role?.config_file;
  if (role !== undefined) {
    if (typeof previous !== 'string' || !existsSync(resolve(dirname(configPath), previous)) ||
        realpathSync(resolve(dirname(configPath), previous)) !== charterPath) {
      throw new Error('agents.spec-explorer exists and is not this checkout’s charter — resolve by hand');
    }
  }
  const edits = [];
  if (previous !== charterPath) {
    edits.push({ keyPath: 'agents.spec-explorer.config_file', value: charterPath, mergeStrategy: 'replace' });
  }
  const description = role?.description ?? 'Read-only codebase exploration for the /spec skill.';
  if (role?.description === undefined) {
    edits.push({ keyPath: 'agents.spec-explorer.description', value: description, mergeStrategy: 'replace' });
  }
  if (edits.length === 0) {
    console.log('unchanged');
  } else {
    await request('config/batchWrite', {
      filePath: configPath,
      expectedVersion: before.version,
      edits,
    });
    const after = await readUser();
    const registered = after.config?.agents?.['spec-explorer'];
    if (registered?.config_file !== charterPath || registered?.description !== description) {
      throw new Error('Codex did not read back spec-explorer’s registration');
    }
    console.log('registered');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  lines?.close();
  child?.stdin.end();
  child?.kill('SIGTERM');
  if (child) setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
}
