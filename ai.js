// How Storm reaches an AI model: through a command-line tool already on this Mac, signed in to
// the user's own subscription. Storm holds no account, key or password of its own; it runs the
// tool, hands it the words, and reads the reply.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Each way in: the subscription, the tool that carries it, and how that tool is asked. */
const PROVIDERS = [
  {
    id: 'claude',
    name: 'Claude',
    tool: 'Claude Code',
    bin: 'claude',
    login: ['auth', 'login'],
    page: 'https://claude.com/claude-code',
    async signedIn(file) {
      const { code, out } = await run(file, ['auth', 'status', '--json']);
      try {
        return JSON.parse(out).loggedIn === true;
      } catch {
        return code === 0;
      }
    },
    /** Claude Code has no command that lists its models, but it keeps the catalogue behind
        its own model menu on disk: each model's id and name, which are current, and which
        model each short name (opus, sonnet…) stands for. Without that file, the short names
        themselves are offered: each means the latest model of its line. */
    usual: 'opus',
    async models() {
      try {
        const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'cache', 'model-catalog');
        const newest = fs
          .readdirSync(dir)
          .filter((f) => /^published-[0-9a-f]+\.json$/.test(f))
          .map((f) => path.join(dir, f))
          .sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs)[0];
        const config = [JSON.parse(fs.readFileSync(newest, 'utf8')).document.surfaces.cc.model_selector_config].flat()[0];
        // The current models only, as Claude Code's own menu shows them; older ones sit in its overflow.
        const named = config.models.filter((m) => m.id && m.name);
        const current = named.filter((m) => m.section === 'main');
        const listed = (current.length ? current : named).map((m) => ({ id: String(m.id), name: `Claude ${m.name}` }));
        if (listed.length) return { list: listed, usual: config.provider_alias_targets?.opus?.default };
      } catch {
        // No catalogue to read: fall back to the short names.
      }
      return [
        { id: 'fable', name: 'Claude Fable' },
        { id: 'opus', name: 'Claude Opus' },
        { id: 'sonnet', name: 'Claude Sonnet' },
        { id: 'haiku', name: 'Claude Haiku' },
      ];
    },
    /** One prompt in, one reply out: no tools, none of the user's own Claude Code setup, nothing kept. */
    async ask(file, { system, prompt, model }, options) {
      const args = ['-p', '--output-format', 'json', '--tools', '', '--safe-mode', '--no-session-persistence', '--system-prompt', system];
      if (model) args.push('--model', model);
      const done = await run(file, args, { ...options, input: prompt, cwd: workDir() });
      const result = lastJson(done.out);
      if (typeof result?.result === 'string' && result.result.trim() && !result.is_error) return result.result.trim();
      throw new Error(reason(result?.result || done.err || done.out, done, this.tool));
    },
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    tool: 'Codex',
    bin: 'codex',
    login: ['login'],
    page: 'https://github.com/openai/codex',
    async signedIn(file) {
      return (await run(file, ['login', 'status'])).code === 0;
    },
    /** Codex keeps a catalogue of the models the account can use, in the order it offers them. */
    async models(file) {
      const { out } = await run(file, ['debug', 'models']);
      const listed = JSON.parse(out).models.filter((m) => m.visibility === 'list' && m.slug);
      return listed.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)).map((m) => ({ id: String(m.slug), name: String(m.display_name || m.slug) }));
    },
    /** Codex has no separate place for instructions, so they lead the prompt. It may read but
        not change anything, in a folder with nothing in it, and writes its reply to a file. */
    async ask(file, { system, prompt, model }, options) {
      const cwd = workDir();
      const reply = path.join(cwd, `reply-${process.pid}-${Date.now()}-${++replies}.txt`);
      const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--ignore-rules', '--color', 'never', '-c', 'mcp_servers={}', '-C', cwd, '-o', reply];
      if (model) args.push('-m', model);
      args.push('-');
      try {
        const done = await run(file, args, { ...options, input: `${system}\n\n${prompt}` });
        const text = done.code === 0 && fs.existsSync(reply) ? fs.readFileSync(reply, 'utf8').trim() : '';
        if (text) return text;
        throw new Error(reason(done.err || done.out, done, this.tool));
      } finally {
        fs.rmSync(reply, { force: true });
      }
    },
  },
];
let replies = 0;

const byId = (id) => PROVIDERS.find((p) => p.id === id) || null;

// ---------- running a tool ----------

// An app opened from the Dock is not given the Terminal's PATH, so the usual homes of a
// command-line tool are looked in directly.
const HOME = os.homedir();
const BIN_DIRS = [path.join(HOME, '.local', 'bin'), path.join(HOME, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.npm-global', 'bin'), path.join(HOME, '.bun', 'bin')];

function isProgram(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Runs a program to its end. Resolves with what it printed and how it ended; `timedOut` is
    set if it was stopped for taking too long. Rejects only if it could not be started, or
    was called off through `signal`. */
function run(file, args, { input = '', cwd, timeout = 15e3, signal } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: [path.dirname(file), ...BIN_DIRS, process.env.PATH].filter(Boolean).join(path.delimiter) };
    const child = spawn(file, args, { cwd, env, signal });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.stdin.on('error', () => {}); // it may be gone before it has read a word
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    });
    child.stdin.end(input);
  });
}

/** Where a tool lives: one of its usual homes, or wherever the user's own shell finds it. */
async function find(bin) {
  for (const dir of BIN_DIRS) {
    const file = path.join(dir, bin);
    if (isProgram(file)) return file;
  }
  try {
    // A login shell may print a greeting of its own first: the answer is the last line that is this program.
    const { out } = await run(process.env.SHELL || '/bin/zsh', ['-lic', `command -v ${bin}`], { timeout: 6e3 });
    const lines = out.split('\n').map((line) => line.trim());
    return lines.reverse().find((line) => path.isAbsolute(line) && path.basename(line) === bin && isProgram(line)) || null;
  } catch {
    return null;
  }
}

/** An empty folder for a tool to run in, so it has no project of the user's to look through. */
function workDir() {
  const dir = path.join(os.tmpdir(), 'storm-ai');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The last line of output that is a JSON object (Claude Code's result). */
function lastJson(out) {
  for (const line of out.split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // not it: keep looking
    }
  }
  return null;
}

/** Why a tool gave no reply, in a line: its own last words, without colour codes. */
function reason(output, done, tool) {
  if (done.timedOut) return `${tool} took too long to reply.`;
  const lines = String(output)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const last = (lines.pop() || '').replace(/^error:\s*/i, '');
  return last ? last.slice(0, 400) : `${tool} stopped without a reply.`;
}

// ---------- what main.js calls ----------

/** The providers as the settings page lists them, before anything has been looked for. */
const list = () => PROVIDERS.map(({ id, name, tool }) => ({ id, name, tool }));

/** Looks on this Mac for each provider's tool: whether it is installed, its version, and
    whether it says it is signed in. Only a reply proves a connection; see `check`. */
function inspect() {
  return Promise.all(
    PROVIDERS.map(async (p) => {
      const facts = { id: p.id, name: p.name, tool: p.tool, installed: false, version: '', signedIn: false };
      const file = await find(p.bin);
      if (!file) return facts;
      try {
        const [version, signedIn] = await Promise.all([run(file, ['--version']), p.signedIn(file)]);
        return { ...facts, installed: true, version: /\d+(\.\d+)+/.exec(version.out)?.[0] || '', signedIn };
      } catch {
        return facts; // found, but it would not run
      }
    })
  );
}

/** The models a provider offers, as `{ id, name }`, the one it is first set to marked `usual`.
    Empty if its tool is missing or will not say. The last answer is kept, since this is
    asked every time the settings page is drawn; `fresh` asks the tool again. */
const offered = new Map();
async function models(id, fresh = false) {
  const provider = byId(id);
  if (!provider) return [];
  if (fresh || !offered.has(id)) {
    let list = [];
    let first = provider.usual;
    try {
      const file = await find(provider.bin);
      const found = file ? await provider.models(file) : [];
      list = Array.isArray(found) ? found : found.list; // a provider may also name its usual model
      first = found.usual || first;
    } catch {
      list = [];
    }
    const usual = list.find((m) => m.id === first) || list[0];
    offered.set(id, list.map((m) => ({ ...m, usual: m === usual })));
  }
  return offered.get(id);
}

/** Sends `{ system, prompt }` through a provider and resolves with the reply's text; `model`
    names the model, or is left out for the tool's own choice. Rejects with a line that says
    what went wrong. `signal` calls it off. */
async function ask(id, request, { signal, timeout = 120e3, model } = {}) {
  const provider = byId(id);
  if (!provider) throw new Error('No AI is connected.');
  const file = await find(provider.bin);
  if (!file) throw new Error(`${provider.tool} was not found on this Mac.`);
  return provider.ask(file, { system: String(request?.system || ''), prompt: String(request?.prompt || ''), model }, { signal, timeout });
}

/** Signs in to a provider by running its tool's own sign-in: the tool opens its page in the
    browser and waits there until the user has finished, for up to ten minutes. Storm sees
    none of it; it only learns how the tool ended. `signal` calls it off, which stops the tool. */
async function signIn(id, { signal } = {}) {
  const provider = byId(id);
  const file = provider && (await find(provider.bin));
  if (!file) return { ok: false, error: provider ? `${provider.tool} was not found on this Mac.` : 'No such provider.' };
  const done = await run(file, provider.login, { cwd: workDir(), timeout: 600e3, signal });
  return done.code === 0 ? { ok: true } : { ok: false, error: done.timedOut ? 'Signing in took too long.' : reason(done.err || done.out, done, provider.tool) };
}

/** Proves a connection the only way that counts: by getting a reply. */
async function check(id, { signal } = {}) {
  const started = Date.now();
  try {
    await ask(id, { system: 'This is a connection check from a writing app. Reply with one word and nothing else.', prompt: 'Reply with the single word: ready' }, { timeout: 60e3, signal });
    return { ok: true, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { list, inspect, models, ask, check, signIn, has: (id) => Boolean(byId(id)), pageOf: (id) => byId(id)?.page || null };
