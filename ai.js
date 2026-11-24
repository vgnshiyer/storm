// How Storm reaches an AI model. Two ways in:
// - a command-line tool already on this Mac, signed in to the user's own subscription. Storm
//   holds no account or password for these; it runs the tool, hands it the words, and reads
//   the reply.
// - an endpoint: an address that answers as a model API, with the user's own API key if it
//   wants one. A model running on this Mac (Ollama, LM Studio) is reached the same way.

const { spawn, execFileSync } = require('node:child_process');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const VERSION = require('./package.json').version;

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
        const listed = (current.length ? current : named).map((m) => ({ id: String(m.id), name: `Claude ${m.name}`, levels: m.thinking?.type === 'effort' ? (m.thinking.effort_options || []).map((o) => String(o.id)) : [] }));
        if (listed.length) return { list: listed, usual: config.provider_alias_targets?.opus?.default };
      } catch {
        // No catalogue to read: fall back to the short names.
      }
      const levels = ['low', 'medium', 'high']; // the latest of each line takes a reasoning level
      return [
        { id: 'fable', name: 'Claude Fable', levels },
        { id: 'opus', name: 'Claude Opus', levels },
        { id: 'sonnet', name: 'Claude Sonnet', levels },
        { id: 'haiku', name: 'Claude Haiku', levels },
      ];
    },
    /** One prompt in, one reply out: no tools, none of the user's own Claude Code setup, nothing
        kept. It prints its work as a line of JSON per event: the reply's words as they come
        (handed to `onText`, whole so far each time), and a last line with the result. */
    async ask(file, { system, prompt, model, effort }, { onText, ...options }) {
      const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--tools', '', '--safe-mode', '--no-session-persistence', '--system-prompt', system];
      if (model) args.push('--model', model);
      if (effort) args.push('--effort', effort);
      let said = '';
      const onLine = (line) => {
        if (!onText || !line.startsWith('{')) return;
        try {
          const delta = JSON.parse(line).event?.delta;
          if (delta?.type === 'text_delta' && delta.text) onText((said += delta.text));
        } catch {
          // not an event: nothing to show
        }
      };
      const done = await run(file, args, { ...options, input: prompt, cwd: workDir(), onLine });
      const result = lastJson(done.out, (line) => line.type === 'result') || lastJson(done.out);
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
    /** Codex keeps a catalogue of the models the account can use, in the order it offers them,
        each with the reasoning levels it takes. */
    async models(file) {
      const { out } = await run(file, ['debug', 'models']);
      const listed = JSON.parse(out).models.filter((m) => m.visibility === 'list' && m.slug);
      return listed.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)).map((m) => ({
        id: String(m.slug),
        name: String(m.display_name || m.slug),
        levels: (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []).map((l) => (typeof l === 'string' ? l : l?.effort)).filter((l) => typeof l === 'string'),
      }));
    },
    /** Codex may read but not change anything, in a folder with nothing in it, and nothing of
        the exchange is kept. It is asked through its app server, which has a place of its own
        for instructions and sends the reply's words as they come. A Codex that has no such
        server, or speaks to it differently, is run the plain way instead, and hands over its
        reply whole. */
    async ask(file, request, options) {
      try {
        return await codexTurn(file, request, options);
      } catch (e) {
        if (options.signal?.aborted || e.final) throw e; // called off, or Codex's own last word
        return this.askWhole(file, request, options);
      }
    },
    /** The plain way: one run of `codex exec`, which writes its reply to a file. It has no
        separate place for instructions, so they lead the prompt. */
    async askWhole(file, { system, prompt, model, effort }, { onText, ...options }) {
      const cwd = workDir();
      const reply = path.join(cwd, `reply-${process.pid}-${Date.now()}-${++replies}.txt`);
      const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--ignore-rules', '--color', 'never', ...codexQuiet(), '-C', cwd, '-o', reply];
      if (model) args.push('-m', model);
      if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
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

// ---------- Codex's app server ----------

/** The user's own Codex setup names servers of tools (MCP) that Codex would start for every
    conversation, and apps it is connected to. A second opinion on a tweet needs none of
    them, and waits for each: these arguments switch them off for this run. */
function codexQuiet() {
  let names = [];
  try {
    const config = fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'config.toml'), 'utf8');
    names = [...config.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+|"[^"\n]+")\]\s*$/gm)].map((m) => m[1]);
  } catch {
    // no setup of its own: nothing to switch off
  }
  return [...names.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]), '--disable', 'apps'];
}

/** One question to Codex through `codex app-server`: a program that takes requests and sends
    events, a line of JSON each, on its input and output. Storm starts it, opens a conversation
    that is not kept (the instructions go in as the conversation's own, the question as its one
    message), and stops it and everything it started when the reply is whole. `onText` is
    handed the reply's words as they come. An error marked `final` is Codex's answer to the
    question (it failed, or took too long); any other means the server could not be spoken to. */
function codexTurn(file, { system, prompt, model, effort }, { onText, signal, timeout = 120e3 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const cwd = workDir();
    const env = { ...process.env, PATH: [path.dirname(file), ...BIN_DIRS, process.env.PATH].filter(Boolean).join(path.delimiter) };
    const child = spawn(file, ['app-server', ...codexQuiet()], { cwd, env });
    const final = (message) => Object.assign(new Error(message), { final: true });
    let settled = false;
    const finish = (error, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', calledOff);
      stopTree(child);
      if (error) reject(error);
      else resolve(text);
    };
    const calledOff = () => finish(signal.reason);
    signal?.addEventListener('abort', calledOff, { once: true });
    const timer = setTimeout(() => finish(final('Codex took too long to reply.')), timeout);

    // Requests are numbered; the answer to each comes back under its number.
    const waiting = new Map();
    let asked = 0;
    const write = (message) => child.stdin.write(JSON.stringify(message) + '\n');
    const request = (method, params) =>
      new Promise((ok, no) => {
        waiting.set(++asked, { ok, no });
        write({ id: asked, method, params });
      });

    let said = ''; // the message being written
    let answer = ''; // the last message written in full
    const heard = (m) => {
      if (m.method === undefined) {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.error) w?.no(new Error(String(m.error.message || 'Codex refused the request.')));
        else w?.ok(m.result);
        return;
      }
      // Codex asking leave to do something (run a command, change a file): not here.
      if (m.id !== undefined) return write({ id: m.id, error: { code: -32601, message: 'Not available here.' } });
      const p = m.params || {};
      if (m.method === 'item/started' && p.item?.type === 'agentMessage') said = '';
      else if (m.method === 'item/agentMessage/delta') {
        said += String(p.delta || '');
        if (said.trim()) onText?.(said);
      } else if (m.method === 'item/completed' && p.item?.type === 'agentMessage') answer = String(p.item.text || '');
      else if (m.method === 'turn/completed') {
        if (p.turn?.status === 'completed' && answer.trim()) finish(null, answer.trim());
        else finish(final(String(p.turn?.error?.message || 'Codex stopped without a reply.').slice(0, 400)));
      }
    };

    let rest = '';
    let err = '';
    child.stdout.on('data', (d) => {
      const lines = (rest + d).split('\n');
      rest = lines.pop();
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue;
        try {
          heard(JSON.parse(line));
        } catch {
          // not a message: nothing to act on
        }
      }
    });
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    child.stdin.on('error', () => {}); // it may be gone before it has read a word
    child.on('error', (e) => finish(e));
    child.on('close', () => finish(new Error(reason(err, {}, 'Codex'))));

    (async () => {
      await request('initialize', { clientInfo: { name: 'storm', title: 'Storm', version: VERSION } });
      write({ method: 'initialized' });
      const started = await request('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true, ...(system && { developerInstructions: system }), ...(model && { model }) });
      await request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: prompt }], ...(effort && { effort }) });
    })().catch((e) => finish(e));
  });
}

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
    was called off through `signal`. `onLine` is handed each line it prints, as it prints it. */
function run(file, args, { input = '', cwd, timeout = 15e3, signal, onLine } = {}) {
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
    let rest = ''; // the line still being printed
    child.stdout.on('data', (d) => {
      out += d;
      if (!onLine) return;
      const lines = (rest + d).split('\n');
      rest = lines.pop();
      for (const line of lines) onLine(line.trim());
    });
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

/** Stops a program and every program under it. A helper may have left its parent's group, so
    each is found by who started it and told to stop by itself; any that is still there a
    moment later, still the same program, is made to. */
function stopTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  let rows = [];
  try {
    const listed = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 2e3 });
    rows = listed.split('\n').map((row) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row)).filter(Boolean).map(([, pid, parent, name]) => ({ pid: Number(pid), parent: Number(parent), name }));
  } catch {
    // no list to go by: the program itself is still stopped
  }
  const under = (pid) => rows.filter((row) => row.parent === pid).flatMap((row) => [...under(row.pid), row]); // deepest first
  const helpers = under(child.pid);
  const tell = (pid, how) => {
    try {
      process.kill(pid, how);
    } catch {
      // gone already
    }
  };
  for (const { pid } of helpers) tell(pid, 'SIGTERM');
  child.kill();
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const { pid, name } of helpers) {
      try {
        // Only if this number is still that program: a number can be handed to another.
        if (execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 2e3 }).trim() === name.trim()) tell(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
  }, 2e3).unref();
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

/** The last line of output that is a JSON object (Claude Code's result), or the last one
    that `fits`. */
function lastJson(out, fits = () => true) {
  for (const line of out.split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const found = JSON.parse(line);
      if (found && fits(found)) return found;
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

// ---------- endpoints ----------
// An endpoint is `{ url, key, model }`. Anthropic's own address is spoken to through its SDK;
// every other address is taken to speak the API OpenAI set, as Ollama, LM Studio and most
// others do: GET /models and POST /chat/completions under the address.

/** The addresses offered ready-made when a model is added. */
const PRESETS = [
  { name: 'OpenAI', url: 'https://api.openai.com/v1' },
  { name: 'Anthropic', url: 'https://api.anthropic.com' },
  { name: 'Ollama', url: 'http://localhost:11434/v1' },
  { name: 'LM Studio', url: 'http://localhost:1234/v1' },
];
const LOCAL = /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[::1\])$/;

/** An address as typed, made whole: a scheme if it has none (http for this Mac, https
    otherwise), "/v1" if it names no path, and no slash at the end. Empty if it is no address. */
function address(typed) {
  let text = String(typed || '').trim();
  if (!text) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = (LOCAL.test(text.split(/[/:]/)[0]) || text.startsWith('[::1]') ? 'http://' : 'https://') + text;
  try {
    const url = new URL(text);
    if (!/^https?:$/.test(url.protocol)) return '';
    const isAnthropic = url.hostname === 'api.anthropic.com';
    const pathname = url.pathname.replace(/\/+$/, '') || (isAnthropic ? '' : '/v1');
    return url.origin + pathname;
  } catch {
    return '';
  }
}

/** What an address is, for the settings page: the name it goes by (a preset's, or its host),
    the host, and whether it is on this Mac. */
function place(url) {
  const at = new URL(url);
  const preset = PRESETS.find((p) => new URL(p.url).host === at.host);
  return { name: preset?.name || at.hostname, host: at.host, local: LOCAL.test(at.hostname) };
}

const speaksAnthropic = (url) => new URL(url).hostname === 'api.anthropic.com';
/** The SDK's client. Anthropic's address is left for the SDK to settle. */
const anthropic = (key, timeout) => new Anthropic({ apiKey: key, maxRetries: 1, timeout });

/** Why Anthropic gave no reply, in a line. */
function anthropicReason(e, model) {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return 'The API key was not accepted.';
  if (e instanceof Anthropic.NotFoundError && model) return `Anthropic has no model called ${model}.`;
  if (e instanceof Anthropic.RateLimitError) return 'Anthropic is turning requests away for now. Try again in a moment.';
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'Anthropic took too long to reply.';
  if (e instanceof Anthropic.APIConnectionError) return 'Anthropic could not be reached.';
  if (e instanceof Anthropic.APIError) return String(e.error?.error?.message || e.message).slice(0, 400);
  return e.message;
}

/** One request to an address that speaks OpenAI's API. Resolves with the JSON it sent back;
    rejects with a line that says what went wrong, in the server's own words where it gave any. */
async function call(url, tail, key, { body, signal, timeout, onEvent }) {
  const { host } = new URL(url);
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (key) headers.authorization = `Bearer ${key}`;
  let reply;
  let text = '';
  try {
    reply = await fetch(url + tail, { method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)].filter(Boolean)) });
    if (onEvent && reply.ok && /event-stream/.test(reply.headers.get('content-type') || '')) {
      // A reply sent piece by piece: each "data:" line is an event; "[DONE]" ends it.
      let rest = '';
      for await (const piece of reply.body.pipeThrough(new TextDecoderStream())) {
        const lines = (rest + piece).split('\n');
        rest = lines.pop();
        for (const line of lines) {
          const sent = /^data:\s*(\{.*)$/.exec(line.trim())?.[1];
          if (!sent) continue;
          let event = null;
          try {
            event = JSON.parse(sent);
          } catch {
            continue;
          }
          if (event.error) throw Object.assign(new Error(String(event.error.message || event.error).slice(0, 400)), { said: true });
          onEvent(event);
        }
      }
      return null;
    }
    text = await reply.text();
  } catch (e) {
    if (signal?.aborted || e.said) throw e;
    throw new Error(e.name === 'TimeoutError' ? `${host} took too long to reply.` : `Nothing answered at ${host}.`);
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Not JSON: an error page, most likely.
  }
  if (reply.ok && data) return data;
  const said = typeof data?.error === 'string' ? data.error : data?.error?.message || data?.message;
  if (typeof said === 'string' && said.trim()) throw new Error(said.trim().slice(0, 400));
  if (reply.status === 401 || reply.status === 403) throw new Error('The API key was not accepted.');
  throw new Error(reply.status === 404 || reply.ok ? `${host} does not answer as a model API at this address.` : `${host} answered with an error (${reply.status}).`);
}

/** The models an endpoint lists, as `{ id, name, levels }`. Only Anthropic says which
    reasoning levels a model takes; elsewhere none are known, so none are offered. */
async function endpointModels({ url, key }, { signal, timeout = 15e3 } = {}) {
  if (speaksAnthropic(url)) {
    if (!key) throw new Error('Anthropic needs an API key.');
    try {
      const listed = [];
      for await (const m of anthropic(key, timeout).models.list({ limit: 100 }, { signal })) {
        const effort = m.capabilities?.effort;
        const levels = effort?.supported ? ['low', 'medium', 'high', 'xhigh', 'max'].filter((l) => effort[l]?.supported) : [];
        if (m.lifecycle !== 'retired') listed.push({ id: m.id, name: m.display_name || m.id, levels });
      }
      return listed;
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new Error(anthropicReason(e));
    }
  }
  const data = await call(url, '/models', key, { signal, timeout });
  const listed = (Array.isArray(data.data) ? data.data : []).filter((m) => m && typeof m.id === 'string' && m.id);
  return listed.map((m) => ({ id: m.id, name: m.id, levels: [] })).sort((x, y) => x.id.localeCompare(y.id, undefined, { numeric: true }));
}

/** What a local model's reply says, without the thinking some write first between <think>
    tags; while that thinking is still being written, nothing. */
function answerOf(text) {
  const answer = text.replace(/^\s*<think>[\s\S]*?<\/think>/, '');
  const start = answer.trimStart();
  return start.startsWith('<think>') || '<think>'.startsWith(start) ? '' : answer;
}

/** Sends `{ system, prompt }` to an endpoint's model and resolves with the reply's text.
    `effort` is the reasoning level, for a model known to take one. The reply is asked for
    piece by piece: `onText` is handed its words as they come, whole so far each time. */
async function askEndpoint({ url, key, model }, request, { signal, timeout = 120e3, effort, onText } = {}) {
  const system = String(request?.system || '');
  const prompt = String(request?.prompt || '');
  let text = '';
  if (speaksAnthropic(url)) {
    if (!key) throw new Error('Anthropic needs an API key.');
    try {
      const stream = anthropic(key, timeout).messages.stream({ model, max_tokens: 8192, ...(system && { system }), ...(effort && { output_config: { effort } }), messages: [{ role: 'user', content: prompt }] }, { signal });
      let said = '';
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') onText?.((said += event.delta.text));
      }
      const message = await stream.finalMessage();
      if (message.stop_reason === 'refusal') throw new Error('Claude declined to answer this.');
      text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new Error(anthropicReason(e, model));
    }
  } else {
    const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
    let said = '';
    const onEvent = (event) => {
      const piece = event.choices?.[0]?.delta?.content;
      if (typeof piece !== 'string' || !piece) return;
      said += piece;
      const answer = answerOf(said).trimStart();
      if (answer) onText?.(answer);
    };
    // A server that does not send piece by piece answers whole, as JSON, and is read that way.
    const data = await call(url, '/chat/completions', key, { body: { model, messages, stream: true }, signal, timeout, onEvent });
    const content = data ? data.choices?.[0]?.message?.content : said;
    text = answerOf(Array.isArray(content) ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('') : String(content ?? ''));
  }
  if (!text.trim()) throw new Error(`${model} gave no reply.`);
  return text.trim();
}

/** Proves an endpoint the same way as a tool: by getting a reply from its model. */
async function checkEndpoint(endpoint, { signal } = {}) {
  const started = Date.now();
  try {
    await askEndpoint(endpoint, CHECK, { timeout: 60e3, signal });
    return { ok: true, ms: Date.now() - started };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { ok: false, error: e.message };
  }
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

/** The models a provider offers, as `{ id, name, levels }` (`levels`: the reasoning levels the
    model takes, none if it takes none), the one it is first set to marked `usual`.
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
    names the model, or is left out for the tool's own choice, and `effort` its reasoning
    level, likewise. `onText` is handed the reply's words as they come, whole so far each
    time, where the provider gives them. Rejects with a line that says what went wrong.
    `signal` calls it off. */
async function ask(id, request, { signal, timeout = 120e3, model, effort, onText } = {}) {
  const provider = byId(id);
  if (!provider) throw new Error('No AI is connected.');
  const file = await find(provider.bin);
  if (!file) throw new Error(`${provider.tool} was not found on this Mac.`);
  return provider.ask(file, { system: String(request?.system || ''), prompt: String(request?.prompt || ''), model, effort }, { signal, timeout, onText });
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
const CHECK = { system: 'This is a connection check from a writing app. Reply with one word and nothing else.', prompt: 'Reply with the single word: ready' };
async function check(id, { signal } = {}) {
  const started = Date.now();
  try {
    await ask(id, CHECK, { timeout: 60e3, signal });
    return { ok: true, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  list,
  inspect,
  models,
  ask,
  check,
  signIn,
  has: (id) => Boolean(byId(id)),
  pageOf: (id) => byId(id)?.page || null,
  presets: PRESETS,
  address,
  place,
  endpointModels,
  askEndpoint,
  checkEndpoint,
};
