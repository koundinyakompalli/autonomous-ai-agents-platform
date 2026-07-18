import * as net from 'node:net'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface SshTunnelOptions {
  sshHost: string
  sshPort?: number
  sshUser?: string
  remoteHost: string
  remotePort: number
  /** Optional ControlMaster socket path for connection multiplexing */
  controlPath?: string
}

export interface SshTunnel {
  localPort: number
  process: ChildProcess
  stderrTail: string[]
  muxForward?: boolean
  controlPath?: string
  sshHost?: string
  sshPort?: number
  sshUser?: string
  remoteHost?: string
  remotePort?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(1000)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
  })
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not allocate local port'))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

export async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await canConnect(port)) return
    await sleep(500)
  }
  throw new Error(`Timed out waiting for SSH tunnel on 127.0.0.1:${port}`)
}

export function buildSshTunnelArgs(opts: SshTunnelOptions, localPort: number): string[] {
  const destination = sshDestination(opts)
  const args = [
    '-N',
    '-L', `127.0.0.1:${localPort}:${opts.remoteHost}:${opts.remotePort}`,
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=1',
    '-o', 'StrictHostKeyChecking=accept-new',
  ]

  if (opts.controlPath) {
    args.push(
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${opts.controlPath}`,
      '-o', 'ControlPersist=5m',
    )
  }

  if (opts.sshPort && opts.sshPort !== 22) {
    args.push('-p', String(opts.sshPort))
  }

  args.push(destination)
  return args
}

function sshDestination(opts: Pick<SshTunnelOptions, 'sshHost' | 'sshUser'>): string {
  return opts.sshUser ? `${opts.sshUser}@${opts.sshHost}` : opts.sshHost
}

export async function startSshTunnel(opts: SshTunnelOptions): Promise<SshTunnel> {
  const localPort = await getFreePort()
  const args = buildSshTunnelArgs(opts, localPort)

  const child = spawn('ssh', args, {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const stderrTail: string[] = []
  child.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString('utf8').trim()
    if (line) stderrTail.push(line)
    if (stderrTail.length > 20) stderrTail.shift()
  })

  // Wait 1 second for early-exit detection. When reusing an existing SSH
  // ControlMaster, OpenSSH may exit code 0 after asking the master to own the
  // port forward, so treat that path as valid only after the local port opens.
  let muxForward = false
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 1000)
    child.once('error', (err) => { clearTimeout(timer); reject(err) })
    child.once('exit', async (code) => {
      clearTimeout(timer)
      if (code === 0 && opts.controlPath) {
        try {
          await waitForPort(localPort, 5_000)
          muxForward = true
          resolve()
          return
        } catch (error) {
          reject(new Error(
            `SSH tunnel mux client exited cleanly, but 127.0.0.1:${localPort} did not become reachable: ${error instanceof Error ? error.message : String(error)} ${stderrTail.join(' ')}`.trim(),
          ))
          return
        }
      }
      reject(new Error(
        `SSH tunnel exited early (code=${code}): ${stderrTail.join(' ')}`,
      ))
    })
  })

  if (!muxForward) {
    await waitForPort(localPort)
  }

  return {
    localPort,
    process: child,
    stderrTail,
    muxForward,
    controlPath: opts.controlPath,
    sshHost: opts.sshHost,
    sshPort: opts.sshPort,
    sshUser: opts.sshUser,
    remoteHost: opts.remoteHost,
    remotePort: opts.remotePort,
  }
}

export async function stopSshTunnel(tunnel: SshTunnel): Promise<void> {
  if (tunnel.muxForward && tunnel.controlPath && tunnel.sshHost && tunnel.remoteHost && tunnel.remotePort) {
    const args = [
      '-S', tunnel.controlPath,
      '-O', 'cancel',
      '-L', `127.0.0.1:${tunnel.localPort}:${tunnel.remoteHost}:${tunnel.remotePort}`,
      '-o', 'BatchMode=yes',
    ]
    if (tunnel.sshPort && tunnel.sshPort !== 22) {
      args.push('-p', String(tunnel.sshPort))
    }
    args.push(sshDestination({
      sshHost: tunnel.sshHost,
      sshUser: tunnel.sshUser,
    }))
    await execFileAsync('ssh', args, {
      timeout: 5_000,
      killSignal: 'SIGTERM',
    }).catch(() => undefined)
    return
  }

  if (tunnel.process.exitCode !== null) return

  tunnel.process.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      tunnel.process.kill('SIGKILL')
      resolve()
    }, 3000)
    tunnel.process.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
