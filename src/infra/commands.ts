/** Subprocess wrapper for running gh, lark-cli, and git commands under the deployment's configured accounts. */
import { execFile, spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { statSync } from 'node:fs'
import { basename, delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Deployment } from '../deployment.ts'

const exec = promisify(execFile)
const TIMEOUT_MS = 90_000
const MAX_BUFFER = 16 * 1024 * 1024
/** Variables every CLI invocation receives: they keep gh and lark-cli from prompting or checking for updates. */
const CLI_ENVIRONMENT = { GH_PROMPT_DISABLED: '1', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }
/**
 * Error thrown by Commands when a CLI invocation fails, capturing stderr diagnostics, API error codes, and exit status without echoing command arguments.
 * Source channels and pollers inspect its code to distinguish deleted conversations from retryable failures.
 */
export class CliError extends Error {
  constructor(message: string, readonly code?: number, readonly exitCode?: number) { super(message) }
}
/** Extracts a sanitized error from a failed subprocess without echoing argv, which may contain message text. */
export function commandError(error: unknown, program = 'command'): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  // Errors raised before a process starts (such as an argument cmd.exe cannot carry) are already sanitized.
  if (error instanceof CliError) return error
  const exitCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    const stderr = error.stderr.trim()
    let parsed: { error?: { code?: number; message?: string } } | undefined
    try { parsed = JSON.parse(stderr.slice(stderr.indexOf('{'))) as typeof parsed }
    catch { /* Non-JSON CLI diagnostics are retained below. */ }
    const code = parsed?.error?.code
    if (parsed?.error?.message) return new CliError(`${parsed.error.message}${code ? ` (${code})` : ''}`, code, exitCode)
    // `gh` exits non-zero on HTTP errors (such as `gh: Not Found (HTTP 404)`) and on `gh: HTTP 304`, which ETag polling relies on.
    if (stderr) return new CliError(stderr.slice(0, 2000), Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || undefined, exitCode)
  }
  return new CliError(`${basename(program)} ${ended(error)}`, undefined, exitCode)
}
function ended(error: unknown): string {
  const { killed, signal, code } = (error ?? {}) as { killed?: boolean; signal?: string | null; code?: unknown }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'printed more output than it may'
  // `execFile` timeout terminates the process with SIGTERM and sets `killed: true`.
  if (killed && signal === 'SIGTERM') return `timed out after ${TIMEOUT_MS / 1000} s`
  if (signal) return `was stopped by ${signal}`
  if (typeof code === 'number') return `exited with code ${code}`
  return typeof code === 'string' ? `could not run: ${code}` : 'failed'
}
export interface Tally { skipped: number }
/** Parses array elements against a schema, skipping invalid items and incrementing `tally.skipped`. */
export function validItems<T>(item: z.ZodType<T>, list: readonly unknown[], tally?: Tally): T[] {
  const items = list.flatMap(value => { const parsed = item.safeParse(value); return parsed.success ? [parsed.data] : [] })
  if (tally) tally.skipped += list.length - items.length
  return items
}
/** Rewrites Feishu error 232011 (bot not in chat) with remediation instructions. */
function membership(error: unknown): unknown {
  if (!(error instanceof CliError) || error.code !== 232011) return error
  const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
  return new CliError(hint, error.code, error.exitCode)
}
/** Windows batch wrappers are the only programs CreateProcess cannot start directly. */
const COMMAND_SCRIPT = /\.(?:cmd|bat)$/i
const windows = process.platform === 'win32'
const comspec = (): string => process.env.ComSpec || 'cmd.exe'
/** Searches the directories of PATH for a command name, trying the extensions Windows can run, in PATHEXT order. */
function searchWindowsPath(program: string): string | undefined {
  const extensions = ['']
  if (!program.includes('.')) extensions.push(...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(extension => extension !== ''))
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = join(directory, program + extension)
      try { if (statSync(candidate).isFile()) return candidate } catch { /* Try the next candidate. */ }
    }
  }
  return undefined
}
/** The batch wrapper a Windows program name resolves to, or `undefined` when it is a native executable. */
function windowsScript(program: string): string | undefined {
  if (!windows) return undefined
  if (isAbsolute(program) || program.includes('/') || program.includes('\\')) return COMMAND_SCRIPT.test(program) ? program : undefined
  const resolved = searchWindowsPath(program)
  return resolved && COMMAND_SCRIPT.test(resolved) ? resolved : undefined
}
const PERCENT = '%'
/**
 * Quotes one argument for the command line cmd.exe parses. cmd.exe has no escape character inside double quotes,
 * so a literal quote is written as a doubled quote (which Windows' argument parser also reads as one quote), the
 * backslashes that parser would otherwise read as escaping a quote are doubled too, and a percent sign is separated
 * from its neighbours by a pair of quotes and a caret so cmd.exe does not expand it; cmd.exe removes the carets
 * before the program sees the argument. Quotes keep every metacharacter literal. Arguments cannot contain line
 * breaks, which cmd.exe treats as command separators.
 */
function windowsArgument(value: string): string {
  let body = ''
  for (let index = 0; index < value.length;) {
    const char = value[index]!
    if (char === '\\') {
      let run = 0
      while (value[index] === '\\') { run += 1; index += 1 }
      const next = index < value.length ? value[index] : ''
      if (next === '"') { body += '\\'.repeat(2 * run) + '""'; index += 1 }
      else if (next === PERCENT) { body += '\\'.repeat(2 * run) + '"^%"'; index += 1 }
      else body += '\\'.repeat(next === '' ? 2 * run : run)
    } else if (char === '"') { body += '""'; index += 1 }
    else if (char === PERCENT) { body += '"^%"'; index += 1 }
    else { body += char; index += 1 }
  }
  return '"' + body + '"'
}
/** The cmd.exe arguments that run a batch wrapper and its arguments; throws for arguments cmd.exe cannot carry. */
function windowsCommandLine(program: string, args: readonly string[]): string[] {
  const values = [program, ...args]
  if (values.some(value => /[\r\n]/.test(value))) throw new CliError('A Windows command script cannot receive an argument containing a line break')
  return ['/d', '/v:off', '/s', '/c', '"' + values.map(windowsArgument).join(' ') + '"']
}
/**
 * The full argv that runs a Windows .cmd/.bat program through cmd.exe, or undefined when the program is a native
 * executable or the platform is not Windows. Spawn sites that cannot start a batch file themselves (such as a
 * subprocess service that rejects EINVAL for a wrapper) run argv[0] with windowsVerbatimArguments and argv.slice(1).
 * @throws CliError when an argument contains a line break cmd.exe cannot carry.
 */
export function commandScriptArgv(program: string, args: readonly string[]): string[] | undefined {
  const script = windowsScript(program)
  return script ? [comspec(), ...windowsCommandLine(script, args)] : undefined
}
/** Terminates a cmd.exe wrapper together with the program it started; cmd.exe does not forward termination itself. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 })
  } catch { /* The program may already have exited. */ }
}
/**
 * Spawns a CLI program. On Windows a .cmd/.bat wrapper is run through cmd.exe with escaped arguments, because
 * CreateProcess cannot start a batch file; kill() then terminates the whole process tree, since cmd.exe would
 * otherwise leave the wrapper's own child running. Every other program keeps the ordinary spawn behavior.
 */
export function spawnCli(program: string, args: string[], options: SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] }): ChildProcessWithoutNullStreams
export function spawnCli(program: string, args: string[], options?: SpawnOptions): ChildProcess
export function spawnCli(program: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  const script = windowsScript(program)
  if (!script) return spawn(program, args, options)
  const child = spawn(comspec(), windowsCommandLine(script, args), { ...options, windowsVerbatimArguments: true })
  const kill = child.kill.bind(child)
  child.kill = (signal?: NodeJS.Signals | number): boolean => { killTree(child); return kill(signal) }
  return child
}
/**
 * Runs a Windows batch wrapper with the timeout, output limit, abort handling and error shape of execFile.
 * execFile cannot run a batch file (CreateProcess rejects it), so its semantics are reproduced over spawnCli.
 * Exported for spawn sites that cannot route a wrapper through their own service (setup probes); the caller supplies
 * the environment, which should be scrubbed the way the service scrubs its children.
 */
export function runCommandScript(program: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; signal: AbortSignal; input?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const aborted = (): Error => Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
    if (options.signal.aborted) { reject(aborted()); return }
    const child = spawnCli(program, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] })
    // Bodies that batch wrappers cannot carry on a command line (multi-line text, JSON) go through stdin.
    if (options.input !== undefined) child.stdin.end(options.input)
    const out: Buffer[] = []; const errors: Buffer[] = []
    let outBytes = 0; let errorBytes = 0; let settled = false
    let stopped: 'abort' | 'timeout' | 'output' | undefined
    const stop = (reason: 'abort' | 'timeout' | 'output'): void => {
      stopped ??= reason
      child.kill('SIGTERM')
    }
    function abort(): void { stop('abort') }
    const settle = (error?: Error, stdout?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(stdout!)
    }
    const timer = setTimeout(() => stop('timeout'), TIMEOUT_MS)
    options.signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length
      if (outBytes > MAX_BUFFER) { stop('output'); return }
      out.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      errorBytes += chunk.length
      if (errorBytes > MAX_BUFFER) { stop('output'); return }
      errors.push(chunk)
    })
    child.once('error', (error: Error) => settle(error))
    child.once('close', (code, signal) => {
      const stderr = Buffer.concat(errors).toString('utf8')
      const stdout = Buffer.concat(out).toString('utf8')
      if (stopped === 'abort') return settle(aborted())
      if (stopped === 'timeout') return settle(Object.assign(new Error(`Command failed: ${basename(program)}`),
        { killed: true, signal: 'SIGTERM', code: null, stderr, stdout }))
      if (stopped === 'output') return settle(Object.assign(new Error(`Command failed: ${basename(program)}`),
        { killed: true, signal: 'SIGTERM', code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stderr, stdout }))
      if (code === 0) return settle(undefined, stdout)
      settle(Object.assign(new Error(`Command failed: ${basename(program)}`), { killed: false, signal, code, stderr, stdout }))
    })
  })
}
/**
 * Executes gh, lark-cli, and git subprocesses with deployment account credentials, timeouts, and abort signals.
 * Restricts GitHub API calls to the configured repository and translates CLI failures into CliError instances for Sources, MasterAssessor, Outbox, and Settings.
 */
export class Commands {
  /**
   * @param resolved - returns the resolved deployment setup, or throws while setup is still pending.
   * @param environment - variables overriding `process.env` for every command (such as isolated git settings).
   */
  constructor(private readonly resolved: () => Deployment, private readonly environment: Record<string, string | undefined>, private readonly signal: AbortSignal) {}
  get deployment(): Deployment { return this.resolved() }
  get repository(): string { return this.deployment.repository }
  withSignal(signal?: AbortSignal): Commands { return signal ? new Commands(this.resolved, this.environment, AbortSignal.any([this.signal, signal])) : this }
  async run(program: string, args: string[], cwd?: string, input?: string): Promise<string> {
    const env = { ...process.env, ...this.environment, ...CLI_ENVIRONMENT }
    try {
      const script = windowsScript(program)
      if (script || input !== undefined) return await runCommandScript(program, args, { cwd, env, signal: this.signal, ...input !== undefined ? { input } : {} })
      const { stdout } = await exec(program, args, { cwd, signal: this.signal, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, env })
      return stdout
    } catch (error) { throw commandError(error, program) }
  }
  /** Runs the agent's GitHub CLI and parses its JSON output; callers should prefer `api`, which is restricted to the configured repository and validates output. */
  async gh<T>(args: string[], input?: string): Promise<T> {
    // Keep the two-argument run call shape when no stdin is used.
    return JSON.parse(await (input === undefined ? this.run(this.deployment.github.cli, args) : this.run(this.deployment.github.cli, args, undefined, input))) as T
  }
  /**
   * Calls a POST API path inside the configured repository with a JSON body on stdin. Batch-script CLIs cannot receive a
   * body containing line breaks as an argument, so the body never touches argv.
   */
  async apiBody<T>(schema: z.ZodType<T>, path: string, body: unknown): Promise<T> {
    return schema.parse(await this.gh(['api', this.path(path), '--method', 'POST', '--input', '-'], JSON.stringify(body)))
  }
  /**
   * Calls the GitHub API on a path within the configured repository, validating JSON output when a schema is provided
   * or returning raw CLI output (such as raw files or `--include` headers) when omitted.
   * @throws CliError with GitHub's HTTP status as `code` on failure.
   */
  async api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async api(path: string, ...flags: string[]): Promise<string>
  async api<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    if (typeof schema === 'string') return this.run(this.deployment.github.cli, ['api', this.path(schema), ...rest])
    const [path = '', ...flags] = rest
    return schema.parse(await this.gh(['api', this.path(path), ...flags]))
  }
  /** Fetches all pages of a GitHub API list within the configured repository, skipping items that fail schema validation. */
  async pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const pages = z.array(z.array(z.unknown())).parse(await this.gh(['api', this.path(path), '--paginate', '--slurp']))
    return validItems(item, pages.flat(), tally)
  }
  private path(path: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error('GitHub calls are restricted to the configured repository')
    return path ? `repos/${this.repository}/${path}` : `repos/${this.repository}`
  }
  /**
   * Runs the Feishu bot's `lark-cli` and returns the JSON `data` payload.
   * @throws CliError with Feishu's error code on failure (rewriting 232011 when the bot is not in the chat).
   */
  async lark<T>(args: string[], cwd?: string): Promise<T> {
    const bot = this.deployment.feishu
    if (!bot) throw new Error('The Feishu Source has no working bot CLI')
    const output = await this.run(bot.cli, [...args, '--as', 'bot', '--format', 'json'], cwd)
      .catch((error: unknown) => { throw membership(error) })
    const result = JSON.parse(output) as { ok: boolean; data: T; error?: { code?: number; message?: string } }
    const code = result.error?.code
    if (!result.ok) throw membership(new CliError((result.error?.message ?? 'Feishu command failed') + (code ? ' (' + code + ')' : ''), code))
    return result.data
  }
  /** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
  async git(args: string[], cwd: string): Promise<string> { return this.run('git', args, cwd) }
}
