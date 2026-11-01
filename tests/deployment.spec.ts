import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, executable, machineOf, resolveDeployment, resolveFeishuBot, workerProbe, type Machine, type Probe } from '../src/deployment.ts'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { workerBin } from '../src/infra/environment.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
const WINDOWS = process.platform === 'win32'
let dir: string
let path: string
/** The path of a stand-in CLI on disk, which is a .cmd launcher on Windows. */
const cli = (name: string): string => join(dir, 'bin', WINDOWS ? name + '.cmd' : name)
/** Writes a stand-in CLI: a POSIX shell script, or a .cmd launcher for a Node script on Windows (cmd cannot run a shell script). */
const program = (file: string, body: string, windows: string): string => {
  if (!WINDOWS) { writeFileSync(file, '#!/bin/sh\n' + body + '\n'); chmodSync(file, 0o755); return file }
  writeFileSync(file + '.js', windows)
  writeFileSync(file + '.cmd', '@echo off\r\n"' + process.execPath + '" "' + file + '.js" %*\r\n')
  return file + '.cmd'
}
/** Fake gh CLI signed in as login with configurable push access to acme/widgets (including its former name acme/gadgets). */
const gh = (file: string, login: string, push = true): string => program(file,
  'case "$*" in\n  "api user") echo \'{"login":"' + login + '","id":7}\' ;;\n  "api repos/acme/"*" --jq {name: .full_name, push: .permissions.push}") echo \'{"name":"acme/widgets","push":' + push + '}\' ;;\n  *) exit 1 ;;\nesac',
  "const args = process.argv.slice(2).join(' ')\nif (args === 'api user') console.log(JSON.stringify({ login: '" + login + "', id: 7 }))\nelse if (args.indexOf('api repos/acme/') === 0) console.log(JSON.stringify({ name: 'acme/widgets', push: " + push + " }))\nelse process.exit(1)\n")
/** Fake lark-cli script body returning canned auth, strict-mode, and bot info responses. */
const lark = (file: string, status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string => program(file,
  'case "$*" in\n  "auth status") echo \'' + JSON.stringify(status) + '\' ;;\n  "config strict-mode") echo \'strict-mode: ' + mode + ' (source: profile)\' ;;\n  "api GET /open-apis/bot/v3/info --as bot --format ndjson") echo \'' + JSON.stringify(bot) + '\' ;;\nesac',
  "const args = process.argv.slice(2).join(' ')\nif (args === 'auth status') console.log('" + JSON.stringify(status) + "')\nelse if (args === 'config strict-mode') console.log('strict-mode: " + mode + " (source: profile)')\nelse if (args.indexOf('api GET /open-apis/bot/v3/info') === 0) console.log('" + JSON.stringify(bot) + "')\n")
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. */
const probe = (async (argv: string[], env: Record<string, string> = {}): Promise<string> => {
  const environment = WINDOWS ? { ...process.env, PATH: path, HOME: dir, ...env } : { PATH: path, HOME: dir, ...env }
  const options = { env: environment, cwd: dir, timeout: 30_000 }
  if (!WINDOWS) return (await exec(argv[0]!, argv.slice(1), options)).stdout
  // Windows cannot execFile a .cmd; cmd /c with verbatim arguments runs the stand-in with its arguments intact.
  const quote = (arg: string): string => arg === '' || /[\s"]/.test(arg) ? '"' + arg.replaceAll('"', '""') + '"' : arg
  return (await exec(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', argv.map(quote).join(' ')], { ...options, windowsVerbatimArguments: true })).stdout
}) as Probe
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  const shims = workerBin(join(dir, 'state'))
  // Stale worker shims with the same binary name must be skipped whatever spelling, normalization or symlink PATH names them by.
  path = WINDOWS
    ? [shims.toUpperCase(), shims + '\\', shims, join(dir, 'bin'), 'C:\\Windows\\System32'].join(delimiter)
    : [join(dir, 'state-link', 'worker-bin'), shims + '/', join(dir, 'bin'), '/usr/bin', '/bin'].join(delimiter)
  gh(join(dir, 'bin', 'gh'), 'Agent-Bot')
  lark(join(dir, 'bin', 'lark-cli'), { appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } })
  if (WINDOWS) writeFileSync(join(shims, 'gh.cmd'), '@echo off\r\nexit /b 1\r\n')
  else program(join(shims, 'gh'), 'exit 1', '')
  if (!WINDOWS) symlinkSync(join(dir, 'state'), join(dir, 'state-link'))
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('requires only the state directory and reads the editable fields through references', () => {
    expect(() => Config({})).toThrow('stateDir')
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: './dir' }))).toThrow()
    // POSIX, Windows drive (with either separator) and UNC state directories are absolute paths on every platform.
    for (const stateDir of ['/srv/dsh-superagent', 'C:\\srv\\dsh-superagent', 'C:/srv/dsh-superagent', '\\\\server\\share\\dsh-superagent']) {
      expect(() => Config(minimal({ stateDir }))).not.toThrow()
    }
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on the GitHub Source), repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
})

describe('setup', () => {
  it('resolves a command name through PATH and PATHEXT, ignores the shim directory, and refuses relative CLI paths', () => {
    const shims = workerBin(machine().stateDir)
    expect(executable('gh', path, shims)).toBe(cli('gh'))
    expect(executable(cli('gh'), path)).toBe(cli('gh'))
    const relative = WINDOWS ? 'bin\\gh' : 'bin/gh'
    expect(() => executable(relative, path)).toThrow(relative + ' must be a command name or an absolute path')
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
    expect(() => executable(join(dir, 'missing'), path)).toThrow(join(dir, 'missing') + ' is not an executable file')
  })
  it('reads the repository from the GitHub Source and the accounts from their CLIs, skipping the worker shims', async () => {
    const deployment = await resolveDeployment(machine(), { repository: 'acme/widgets', cli: 'gh' }, probe, path)
    expect(deployment).toMatchObject({ repository: 'acme/widgets', github: { cli: cli('gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
    expect(deployment.github).toEqual({ cli: cli('gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(deployment).not.toHaveProperty('feishu')
    // A renamed repository is still resolved by its old name; notifications carry GitHub's current full_name.
    expect((await resolveDeployment(machine(), { repository: 'acme/gadgets', cli: 'gh' }, probe, path)).repository).toBe('acme/widgets')
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveDeployment(machine(), github, probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    await needs('github', 'repositoryUnset', {}, { cli: 'gh' })
    await needs('github', 'agentCliUnset', {}, { repository })
    await needs('github', 'agentCliMissing', { output: join(dir, 'missing') + ' is not an executable file' }, { repository, cli: join(dir, 'missing') })
    await needs('github', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, { repository, cli: 'bin/gh' })
    if (WINDOWS) await needs('github', 'agentCliMissing', { output: 'bin\\gh must be a command name or an absolute path' }, { repository, cli: 'bin\\gh' })
    const broken = program(join(dir, 'bin', 'gh-broken'), 'exit 1', 'process.exit(1)\n')
    await needs('github', 'agentCliSignedOut', {}, { repository, cli: broken })
    await needs('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repository, cli: gh(join(dir, 'bin', 'gh-reader'), 'Agent-Bot', false) })
    // Signed in, but the account cannot read the repository, or the CLI names no account.
    const unreadable = program(join(dir, 'bin', 'gh-outsider'),
      'case "$*" in\n  "api user") echo \'{"login":"Agent-Bot","id":7}\' ;;\n  *) echo \'HTTP 404\' >&2; exit 1 ;;\nesac',
      "const args = process.argv.slice(2).join(' ')\nif (args === 'api user') console.log(JSON.stringify({ login: 'Agent-Bot', id: 7 }))\nelse { process.stderr.write('HTTP 404\\n'); process.exit(1) }\n")
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repository, cli: unreadable })
    await needs('github', 'agentCliNoAccount', {}, { repository, cli: program(join(dir, 'bin', 'gh-anonymous'), "echo '{}'", "process.stdout.write('{}\\n')\n") })
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: cli('lark-cli'), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
    lark(join(dir, 'bin', 'lark-cli'), { identities: { bot: { status: 'ready' } } })
    await refuses('feishuNoApp')
    lark(join(dir, 'bin', 'lark-cli'), { appId: 'cli_bot', identities: { bot: { status: 'missing' } } })
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    lark(join(dir, 'bin', 'lark-cli'), { appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off')
    await refuses('feishuUserIdentity', { mode: 'off' })
    lark(join(dir, 'bin', 'lark-cli'), { appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} })
    await refuses('feishuNoBot')
    program(join(dir, 'bin', 'lark-cli'), 'echo "not configured" >&2; exit 1', "process.stderr.write('not configured\\n')\nprocess.exit(1)\n")
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
})

describe('worker probe', () => {
  it('runs a batch-script CLI through cmd.exe with the scrubbed environment, or through the subprocess service otherwise', async () => {
    const state = join(dir, 'state')
    const calls: { argv: string[]; env?: Record<string, string> }[] = []
    const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
    const subprocess = { spawn: (spec: { argv: string[]; env?: Record<string, string> }) => {
      calls.push(spec)
      return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: reader('{}'), stderr: reader('') } }
    } } as unknown as SubprocessRuntime
    const cliPath = join(dir, 'bin', 'gh-agent.cmd')
    const cliScript = join(dir, 'bin', 'gh-agent.js')
    writeFileSync(cliScript, "process.stdout.write(JSON.stringify({ kept: process.env.WORKER_PROBE_TEST ?? null, leaked: process.env.WORKER_PROBE_AMBIENT_SECRET ?? null }))\n")
    writeFileSync(cliPath, '@echo off\r\n"' + process.execPath + '" "' + cliScript + '" %*\r\n')
    vi.stubEnv('WORKER_PROBE_AMBIENT_SECRET', 'must-not-leak')
    try {
      const probe = workerProbe(subprocess, state, dir, new AbortController().signal)
      const output = await probe([cliPath, 'api', 'user'], { WORKER_PROBE_TEST: 'kept' })
      if (WINDOWS) {
        // The batch wrapper cannot go through the service; it runs through cmd.exe with the service's scrubbed environment.
        expect(calls).toHaveLength(0)
        expect(JSON.parse(output)).toEqual({ kept: 'kept', leaked: null })
      } else {
        expect(calls).toHaveLength(1)
        expect(calls[0]!.argv).toEqual([cliPath, 'api', 'user'])
        expect(calls[0]!.env).toMatchObject({ WORKER_PROBE_TEST: 'kept' })
      }
    } finally { vi.unstubAllEnvs() }
  })
})
