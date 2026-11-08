'use strict';
/**
 * Process helpers: bounded child processes, streaming line parser, platform
 * argument shims for ping, and resolution of a curl binary that supports
 * `-o NUL` on Windows.
 *
 * Rules baked in here:
 *  - every spawn gets a hard kill timer, so a hung probe can never wedge the app
 *  - arguments are always passed as an array (never a shell string)
 *  - a global child registry caps how many probes run at once
 */
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';
const SINK = IS_WIN ? 'NUL' : '/dev/null';

const CURL_CANDIDATES = [
  process.env.NETPULSE_CURL,
  IS_WIN ? 'C:\\Windows\\System32\\curl.exe' : '/usr/bin/curl',
  'curl',
].filter(Boolean);

let curlPath = null;
function resolveCurl() {
  if (curlPath) return curlPath;
  for (const c of CURL_CANDIDATES) {
    try {
      if (c.includes(path.sep) || c.includes('/') || c.includes('\\')) {
        if (fs.existsSync(c)) {
          curlPath = c;
          return curlPath;
        }
      } else {
        curlPath = c;
        return curlPath;
      }
    } catch {
      /* keep looking */
    }
  }
  throw new Error('no usable curl binary found');
}

/** ping argument shim: Windows vs POSIX spellings of the same probe. */
function pingArgs({ host, count = 1, timeoutMs = 1500, payload = 32, df = false, continuous = false }) {
  if (IS_WIN) {
    const a = continuous ? ['-t'] : ['-n', String(count)];
    if (!continuous) a.push('-w', String(timeoutMs));
    if (payload && payload !== 32) a.push('-l', String(payload));
    if (df) a.push('-f');
    a.push(host);
    return a;
  }
  const a = continuous ? [] : ['-c', String(count)];
  if (!continuous) a.push('-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))));
  if (payload && payload !== 32) a.push('-s', String(payload));
  if (df) a.push('-M', 'do');
  a.push(host);
  return a;
}

const children = new Set();
const MAX_CHILDREN = 24;

function register(child, hardKillMs) {
  children.add(child);
  let timer = null;
  if (hardKillMs) {
    timer = setTimeout(() => {
      try {
        if (IS_WIN) execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () => {});
        else child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, hardKillMs);
    if (timer.unref) timer.unref();
  }
  const done = () => {
    if (timer) clearTimeout(timer);
    children.delete(child);
  };
  child.once('exit', done);
  child.once('error', done);
  return child;
}

function childCount() {
  return children.size;
}

function killAll() {
  for (const c of children) {
    try {
      if (IS_WIN) execFile('taskkill', ['/pid', String(c.pid), '/t', '/f'], () => {});
      else c.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  children.clear();
}

function atCap() {
  return children.size >= MAX_CHILDREN;
}

/** Run a command to completion with a hard timeout. Never rejects on non-zero exit. */
function run(cmd, args, { timeoutMs = 30_000, cwd } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, cwd });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e && e.message), spawnError: true });
      return;
    }
    register(child, timeoutMs + 5000);
    const killTimer = setTimeout(() => {
      try {
        if (IS_WIN) execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () => {});
        else child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    if (killTimer.unref) killTimer.unref();
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(killTimer);
      resolve({ code: -1, stdout: out, stderr: String(e && e.message), spawnError: true });
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

/**
 * Stream a long-lived process line by line. Used for `ping -t` so latency
 * samples arrive as they happen instead of only at exit.
 */
function streamLines(cmd, args, handlers = {}) {
  const { onLine, onExit, stderr = true } = handlers;
  let child;
  try {
    child = spawn(cmd, args, { windowsHide: true });
  } catch (e) {
    if (onExit) onExit(-1, String(e && e.message));
    return { kill() {} };
  }
  register(child);
  // A line can straddle two chunks: typeperf emits CSV rows several KB wide,
  // and a busy pipe can split a reply mid-line. Buffer the tail instead of
  // treating every chunk as whole lines.
  let carry = '';
  const pump = (chunk) => {
    carry += chunk.toString();
    const parts = carry.split(/\r?\n/);
    carry = parts.pop();
    for (const line of parts) {
      if (line.trim()) onLine && onLine(line.trim());
    }
    // Runaway guard: a producer that never emits a newline must not grow this
    // buffer without bound.
    if (carry.length > 4 * 1024 * 1024) carry = '';
  };
  child.stdout.setEncoding('utf8');
  if (stderr) child.stderr.setEncoding('utf8');
  child.stdout.on('data', pump);
  if (stderr) child.stderr.on('data', pump);
  child.on('error', (e) => onExit && onExit(-1, String(e && e.message)));
  child.on('close', (code) => onExit && onExit(code, null));
  return {
    pid: child.pid,
    kill() {
      try {
        if (IS_WIN) execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () => {});
        else child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    },
  };
}

/** Random payload file for upload tests, generated once and reused. */
function payloadPath(bytes) {
  const dir = path.join(os.tmpdir(), 'netpulse');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `payload-${bytes}.bin`);
  try {
    const st = fs.statSync(p);
    if (st.size === bytes) return p;
  } catch {
    /* regenerate */
  }
  const buf = Buffer.alloc(1024 * 1024, 0x5a);
  const fd = fs.openSync(p, 'w');
  try {
    let written = 0;
    while (written < bytes) {
      const n = Math.min(buf.length, bytes - written);
      fs.writeSync(fd, buf, 0, n);
      written += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return p;
}

function mbps(bytes, seconds) {
  if (!seconds || seconds <= 0) return 0;
  return (bytes * 8) / seconds / 1e6;
}

function mbpsToMBs(m) {
  return m / 8;
}

module.exports = {
  IS_WIN,
  SINK,
  resolveCurl,
  pingArgs,
  run,
  streamLines,
  payloadPath,
  mbps,
  mbpsToMBs,
  childCount,
  killAll,
  atCap,
};
