/** Tests for scripts/dsh-superagent.ps1 on Windows, with a temporary checkout, a fake dsh .cmd and its node-backed fake service. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync }
  from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const CRLF = '\r\n'
/** The fake service writes its pid, announces itself on stdout and stderr, and exits on Ctrl+C unless told to ignore it. */
const FAKE_DSH = [
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  "const root = path.dirname(__dirname)",
  "const pids = path.join(root, 'pids')",
  "fs.mkdirSync(pids, { recursive: true })",
  "fs.writeFileSync(path.join(pids, String(process.pid)), '')",
  "fs.writeFileSync(path.join(root, 'launched'), String(process.pid))",
  "console.log('fake dsh stdout')",
  "console.error('fake dsh stderr')",
  "process.on('SIGINT', () => { if (!process.env.FAKE_DSH_IGNORE_SIGINT) process.exit(0) })",
  "setInterval(() => {}, 60000)",
  ''
].join('\n')
const READY = { health: { runtime: { state: 'ready', detail: '' } }, setup: { problem: null, feishuProblem: null } }

let root: string
let server: Server | undefined
const children: ChildProcess[] = []
/** A per-run profile name, so these tests never see or touch a real dsh-superagent service on this machine. */
const PROFILE = 'test-' + process.pid
const control = (profile = PROFILE) => join(root, '.artifacts', 'control', 'profiles', profile)
const script = () => join(root, 'scripts', 'dsh-superagent.ps1')
const fakeDsh = () => join(root, 'bin', 'fake-dsh.js')
const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
async function waitFor(check: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await delay(50)
  }
  throw new Error('Condition not met in time')
}
/** A dsh service process whose command line the runner's Win32_Process scan finds; used when the test needs one without the start command. */
function spawnService(...args: string[]): ChildProcess {
  const child = spawn(process.execPath, [fakeDsh(), ...args], { stdio: 'ignore', windowsHide: true })
  children.push(child)
  return child
}
function serviceEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'Path'
  env[pathKey] = join(root, 'bin') + ';' + (env[pathKey] ?? '')
  env.DSH_SUPERAGENT_PROFILE = PROFILE
  env.DSH_SUPERAGENT_URL = ''
  // Keep stale-lock cleanup away from the real %USERPROFILE%\.dsh\state during tests.
  env.DSH_SUPERAGENT_STATE_ROOT = join(root, 'state')
  return env
}
function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script(), ...args],
      { env: serviceEnv(), timeout: 60_000, windowsHide: true },
      (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr }))
  })
}
/** Run a command through scripts/dsh-superagent.cmd, as an operator in PowerShell does. */
function runWrapper(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = "& '" + join(root, 'scripts', 'dsh-superagent.cmd') + "' " + args.map(argument => "'" + argument + "'").join(' ') + '; exit $LASTEXITCODE'
  return new Promise(resolve => {
    execFile(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { env: serviceEnv(), timeout: 60_000, windowsHide: true },
      (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr }))
  })
}
const liveLaunched = (): boolean => {
  try {
    const pid = Number(readFileSync(join(root, 'launched'), 'utf8'))
    return pid > 0 && isAlive(pid)
  } catch {
    return false
  }
}
/** Start a mock management API that answers 503 until a launched fake service is alive (unless always is true). */
async function answering(state: unknown = READY, always = false): Promise<string> {
  server = createServer((_request, response) => {
    if (!always && !liveLaunched()) { response.writeHead(503).end(); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return 'http://127.0.0.1:' + (server!.address() as AddressInfo).port
}
interface Status { pids: number[]; cwd: string; url: string; manually_stopped: boolean; health: Record<string, string> | null;
  errors: Record<string, string> | null; setup: unknown; feishu: unknown }
async function status(profile: string, url = 'http://127.0.0.1:9'): Promise<Status> {
  return JSON.parse((await run('status', '--profile', profile, '--url', url)).stdout) as Status
}
const readPidFile = (name: string, profile = PROFILE): number => Number(readFileSync(join(control(profile), name), 'utf8').trim())
const profileDirectories = (): string[] => {
  try { return readdirSync(join(root, '.artifacts', 'control', 'profiles')) } catch { return [] }
}
/** Kill every process this test started: the fake services, the recorded service and launcher pids, and the log-writing command shells. */
async function killProcesses(): Promise<void> {
  const pids: number[] = []
  for (const profile of profileDirectories()) {
    for (const name of ['service.pid', 'launcher.pid']) {
      try { pids.push(readPidFile(name, profile)) } catch { /* not recorded */ }
    }
  }
  try { for (const name of readdirSync(join(root, 'pids'))) pids.push(Number(name)) } catch { /* no fake services */ }
  for (const pid of pids) {
    if (pid > 0) { try { process.kill(pid) } catch { /* already gone */ } }
  }
  if (pids.length > 0) await waitFor(() => pids.every(pid => !isAlive(pid)), 5000).catch(() => undefined)
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'service script windows '))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'bin'))
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent.ps1'), join(root, 'scripts', 'dsh-superagent.ps1'))
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent.cmd'), join(root, 'scripts', 'dsh-superagent.cmd'))
  writeFileSync(join(root, 'bin', 'dsh.cmd'), '@echo off' + CRLF + 'node "%~dp0fake-dsh.js" %*' + CRLF)
  // npm installs an ExternalScript dsh.ps1 beside dsh.cmd; Get-Command's default first match is the .ps1,
  // so the runner must resolve Application commands explicitly and prefer the cmd shim.
  writeFileSync(join(root, 'bin', 'dsh.ps1'), '# npm-style PowerShell shim; the service runner must not select it' + CRLF
    + 'throw "dsh.ps1 must not be used by the service runner"' + CRLF)
  writeFileSync(fakeDsh(), FAKE_DSH)
})
afterEach(async () => {
  server?.close()
  server = undefined
  for (const child of children.splice(0)) {
    try { child.kill() } catch { /* already gone */ }
  }
  await killProcesses()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  delete process.env.FAKE_DSH_IGNORE_SIGINT
})

describe.runIf(process.platform === 'win32')('the Windows service script', () => {
  it('reports a stopped service as JSON with no process and no health', async () => {
    const stopped = await run('status')
    expect(stopped.code).toBe(1)
    expect(JSON.parse(stopped.stdout)).toMatchObject({ pids: [], cwd: root, url: 'http://127.0.0.1:3082',
      manually_stopped: false, health: null, errors: null, setup: null, feishu: null })
  }, 60_000)
  it('keeps a stop per profile and skips automatic recovery after it', async () => {
    expect(await run('stop', '--profile', 'one')).toMatchObject({ code: 0, stdout: expect.stringContaining('Automatic recovery is paused') })
    expect(existsSync(join(control('one'), 'manually-stopped'))).toBe(true)
    expect(await status('one')).toMatchObject({ manually_stopped: true, pids: [] })
    expect(await status('two')).toMatchObject({ manually_stopped: false })
    const skipped = await run('--respect-stop', 'start', '--profile', 'one')
    expect(skipped).toMatchObject({ code: 0, stdout: expect.stringContaining('Intentional stop is active') })
    expect(existsSync(join(control('one'), 'service.pid'))).toBe(false)
  }, 60_000)
  it('takes no dsh plugin command of the profile for its service', async () => {
    spawnService('plugin', '--profile', PROFILE, 'add', 'link:/x')
    const service = spawnService('--profile', PROFILE, '--no-open')
    const url = await answering(READY, true)
    await waitFor(() => service.pid !== undefined && isAlive(service.pid))
    const listed = await status(PROFILE, url)
    expect(listed.pids).toEqual([service.pid])
  }, 60_000)
  it('starts the service in a hidden console, records the PID and the log, and reports ready status', async () => {
    const url = await answering()
    const started = await run('start', '--url', url, '--timeout', '20')
    expect(started.code).toBe(0)
    const log = /Log: (.*)/.exec(started.stdout)?.[1]?.trim()
    expect(log).toBeTruthy()
    expect(basename(log!)).toMatch(new RegExp('^dsh-superagent-' + PROFILE + '-\\d{8}-\\d{6}-\\d+\\.log$'))
    const pid = readPidFile('service.pid')
    expect(pid).toBeGreaterThan(0)
    expect(isAlive(pid)).toBe(true)
    await waitFor(() => {
      try { return readFileSync(log!, 'utf8').includes('fake dsh stderr') } catch { return false }
    })
    expect(readFileSync(log!, 'utf8')).toContain('fake dsh stdout')
    const checked = await run('status', '--url', url)
    expect(checked.code).toBe(0)
    expect(JSON.parse(checked.stdout)).toMatchObject({ pids: [pid], manually_stopped: false,
      health: { runtime: 'ready' }, errors: {}, setup: null, feishu: null })
  }, 60_000)
  it('records the service PID at start, and refuses a second instance the scan finds', async () => {
    const url = await answering()
    expect((await run('start', '--url', url, '--timeout', '20')).code).toBe(0)
    const pid = readPidFile('service.pid')
    spawnService('--profile', PROFILE, '--no-open')
    await delay(500)
    const again = await run('start', '--url', url, '--timeout', '5')
    expect(again).toMatchObject({ code: 1, stderr: expect.stringContaining('Multiple dsh-superagent processes found; refusing to start another.') })
    expect((await status(PROFILE, url)).pids).toHaveLength(2)
    expect((await status(PROFILE, url)).pids).toContain(pid)
  }, 60_000)
  it('stops the started service gracefully, removes its files and leaves no launcher shell', async () => {
    const url = await answering()
    expect((await run('start', '--url', url, '--timeout', '20')).code).toBe(0)
    const pid = readPidFile('service.pid')
    const launcher = readPidFile('launcher.pid')
    const stopped = await run('stop', '--stop-timeout', '20')
    expect(stopped).toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent stopped. Automatic recovery is paused until start/restart.') })
    expect(existsSync(join(control(), 'manually-stopped'))).toBe(true)
    expect(existsSync(join(control(), 'service.pid'))).toBe(false)
    expect(existsSync(join(control(), 'launcher.pid'))).toBe(false)
    expect(isAlive(pid)).toBe(false)
    expect(isAlive(launcher)).toBe(false)
    expect(JSON.parse((await run('status', '--url', url)).stdout)).toMatchObject({ pids: [], manually_stopped: true, health: null })
  }, 60_000)
  it('restarts the service, and a stop whose graceful shutdown timed out keeps the intentional stop', async () => {
    const url = await answering()
    expect((await run('start', '--url', url, '--timeout', '20')).code).toBe(0)
    const first = readPidFile('service.pid')
    const restarted = await run('restart', '--url', url, '--timeout', '20', '--stop-timeout', '20')
    expect(restarted).toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent stopped.') })
    expect(restarted.stdout).not.toContain('Automatic recovery is paused')
    expect(existsSync(join(control(), 'manually-stopped'))).toBe(false)
    expect(isAlive(first)).toBe(false)
    const second = readPidFile('service.pid')
    expect(second).not.toBe(first)
    expect((await status(PROFILE, url)).pids).toEqual([second])
    // A service that ignores Ctrl+C is left running, and its intentional stop stays recorded after the timeout.
    process.env.FAKE_DSH_IGNORE_SIGINT = '1'
    const pid = readPidFile('service.pid')
    expect(await run('stop', '--stop-timeout', '1')).toMatchObject({ code: 1, stderr: expect.stringContaining('Graceful stop timed out') })
    expect(isAlive(pid)).toBe(true)
    expect(existsSync(join(control(), 'manually-stopped'))).toBe(true)
  }, 90_000)
  it('exits 1 when the started service does not answer in time, and leaves its process running', async () => {
    // Port 0 never accepts a connection, so each health check fails without waiting for the two-second timeout.
    const started = await run('start', '--url', 'http://127.0.0.1:0', '--timeout', '2')
    expect(started).toMatchObject({ code: 1, stderr: expect.stringContaining('Startup health check timed out') })
    expect(isAlive(readPidFile('service.pid'))).toBe(true)
  }, 60_000)
  it('refuses to stop when two processes serve the profile, before it writes the stop marker', async () => {
    spawnService('--profile', PROFILE, '--no-open')
    spawnService('--profile=' + PROFILE, '--no-open')
    await delay(500)
    expect(await run('stop', '--stop-timeout', '2')).toMatchObject({ code: 1, stderr: expect.stringContaining('Multiple dsh-superagent processes found') })
    expect(existsSync(join(control(), 'manually-stopped'))).toBe(false)
  }, 60_000)
  it('does not signal a process that took the recorded service PID', async () => {
    mkdirSync(control(), { recursive: true })
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
    children.push(other)
    await waitFor(() => other.pid !== undefined && isAlive(other.pid))
    writeFileSync(join(control(), 'service.pid'), String(other.pid) + CRLF)
    expect(await run('stop', '--stop-timeout', '2')).toMatchObject({ code: 0 })
    expect(isAlive(other.pid!)).toBe(true)
  }, 60_000)
  it('exits 2 while a part such as a Source reports an error, which a restart does not fix, and prints what it reports', async () => {
    spawnService('--profile', PROFILE, '--no-open')
    await delay(500)
    const github = { health: { runtime: { state: 'ready', detail: '' }, github: { state: 'error', detail: 'bad token' } }, setup: {} }
    const url = await answering(github, true)
    const checked = await run('status', '--url', url)
    expect(checked.code).toBe(2)
    expect(JSON.parse(checked.stdout)).toMatchObject({ errors: { github: 'bad token' } })
    expect(await run('start', '--url', url, '--timeout', '10'))
      .toMatchObject({ code: 2, stdout: expect.stringContaining('github reports an error, which a restart does not fix: bad token') })
  }, 60_000)
  it('exits 3 while the service waits for setup, from status and from start, which a restart does not fix', async () => {
    spawnService('--profile', PROFILE, '--no-open')
    await delay(500)
    const waiting = { health: { runtime: { state: 'paused', detail: '' } },
      setup: { problem: { code: 'repositoryUnset', detail: 'The GitHub Source names no repository.' }, feishuProblem: null } }
    const url = await answering(waiting, true)
    expect((await run('status', '--url', url)).code).toBe(3)
    expect(await run('start', '--url', url, '--timeout', '10'))
      .toMatchObject({ code: 3, stdout: expect.stringContaining('waiting for setup: The GitHub Source names no repository.') })
  }, 60_000)
  it('reports a service whose Feishu bot setup could not check as running, and reads an answer with keys missing', async () => {
    spawnService('--profile', PROFILE, '--no-open')
    await delay(500)
    const feishu = { health: { runtime: { state: 'ready', detail: '' }, feishu: { state: 'paused', detail: '' } },
      setup: { problem: null, feishuProblem: { code: 'feishuNoBot', detail: 'No bot' } } }
    expect((await run('status', '--url', await answering(feishu, true))).code).toBe(0)
    server!.close()
    expect((await run('status', '--url', await answering({ health: { runtime: { state: 'ready' } } }, true))).code).toBe(0)
    server!.close()
    expect((await run('status', '--url', await answering({ health: { runtime: { state: 'error' } } }, true))).code).toBe(1)
  }, 60_000)
  it('keeps only the newest logs it wrote for the profile', async () => {
    const url = await answering()
    mkdirSync(join(root, '.artifacts'), { recursive: true })
    for (const profile of [PROFILE, 'other']) for (let index = 0; index < 25; index++) {
      const log = join(root, '.artifacts', 'dsh-superagent-' + profile + '-20260901-0000' + String(index).padStart(2, '0') + '-1.log')
      writeFileSync(log, '')
      utimesSync(log, 1_700_000_000 + index, 1_700_000_000 + index)
    }
    writeFileSync(join(root, '.artifacts', 'dsh-superagent-20260901-000000-1.log'), '')
    expect((await run('start', '--url', url, '--timeout', '20')).code).toBe(0)
    const logs = readdirSync(join(root, '.artifacts'))
    const own = logs.filter(name => name.startsWith('dsh-superagent-' + PROFILE + '-')).sort()
    expect(own).toHaveLength(20)
    expect(own).not.toContain('dsh-superagent-' + PROFILE + '-20260901-000000-1.log')
    expect(own.filter(name => !name.startsWith('dsh-superagent-' + PROFILE + '-20260901-'))).toHaveLength(1)
    expect(logs.filter(name => name.startsWith('dsh-superagent-other-'))).toHaveLength(25)
    expect(logs).toContain('dsh-superagent-20260901-000000-1.log')
  }, 60_000)
  it('refuses a second control operation while one holds the profile lock', async () => {
    mkdirSync(control(), { recursive: true })
    const descriptor = openSync(join(control(), 'operation.lock'), 'w')
    try {
      expect(await run('status'))
        .toMatchObject({ code: 1, stderr: expect.stringContaining('Another dsh-superagent control operation is in progress') })
    } finally {
      closeSync(descriptor)
    }
    expect((await run('status')).stderr).not.toContain('Another dsh-superagent control operation is in progress')
  }, 60_000)
  it('removes a stale state lock left by a force-killed process before starting', async () => {
    const url = await answering()
    const lock = join(root, 'state', PROFILE + '.lock')
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'stale'), '')
    const started = await run('start', '--url', url, '--timeout', '20')
    expect(started.code).toBe(0)
    expect(existsSync(lock)).toBe(false)
  }, 60_000)
  it('stops through the service\'s parent shell when launcher.pid is stale', async () => {
    const url = await answering()
    expect((await run('start', '--url', url, '--timeout', '20')).code).toBe(0)
    const pid = readPidFile('service.pid')
    writeFileSync(join(control(), 'launcher.pid'), '999999' + CRLF)
    const stopped = await run('stop', '--stop-timeout', '20')
    expect(stopped.code).toBe(0)
    expect(isAlive(pid)).toBe(false)
    expect(existsSync(join(control(), 'launcher.pid'))).toBe(false)
  }, 60_000)
  it('serves the same commands through the .cmd wrapper', async () => {
    const listed = await runWrapper('status')
    expect(listed.code).toBe(1)
    expect(JSON.parse(listed.stdout)).toMatchObject({ pids: [], manually_stopped: false })
    expect((await runWrapper('stop', '--profile', 'wrapped')).code).toBe(0)
    expect(existsSync(join(control('wrapped'), 'manually-stopped'))).toBe(true)
  }, 60_000)
  it('exits 2 on an invalid command line', async () => {
    expect((await run('frobnicate')).code).toBe(2)
    expect((await run('start', '--timeout', '0')).code).toBe(2)
  }, 60_000)
})
