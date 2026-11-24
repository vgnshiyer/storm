const { app, BrowserWindow, Menu, ipcMain, clipboard, ClipboardItem, shell, dialog, nativeImage, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const ai = require('./ai');

// One Markdown file per storm, in Documents/Storms unless another folder has been chosen in
// Settings (see "the storms' folder" below). STORM_DIR overrides the folder and keeps the
// app's own state beside it, so a test run never touches the real storms or settings.
const DEFAULT_DIR = path.join(app.getPath('documents'), 'Storms');
let DIR = process.env.STORM_DIR || DEFAULT_DIR;
if (process.env.STORM_DIR) {
  app.setPath('userData', path.join(DIR, '.userdata'));
  app.setName('Storm Test'); // and its own entry in the Keychain, not the app's
}

// ---------- storms ----------

function fileFor(id) {
  if (typeof id !== 'string' || !id || id.startsWith('.') || path.basename(id) !== id) {
    throw new Error('Bad storm id');
  }
  return path.join(DIR, id + '.md');
}

function list() {
  fs.mkdirSync(DIR, { recursive: true });
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .map((f) => {
      const p = path.join(DIR, f);
      return { id: f.slice(0, -3), text: fs.readFileSync(p, 'utf8'), mtime: fs.statSync(p).mtimeMs };
    });
}

/** Writes a storm. `mtime` is when its words last changed: the file is dated to that, so
    renaming a storm does not move it up the list. */
function save(id, text, mtime) {
  fs.mkdirSync(DIR, { recursive: true });
  const p = fileFor(id);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
  if (Number.isFinite(mtime)) {
    try {
      fs.utimesSync(p, new Date(), new Date(mtime));
    } catch {
      // The date is a nicety; the storm itself is saved.
    }
  }
}

async function remove(id) {
  const p = fileFor(id);
  if (fs.existsSync(p)) await shell.trashItem(p);
}

// ---------- images on tweets ----------
// A storm's images are copied into a folder of its own beside its file, with the same name,
// and the storm's Markdown points at them. The originals are left where they were.

const MEDIA_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const STORM_ID = /^\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?$/; // the names the app gives its own storms
const mediaDir = (id) => fileFor(id).slice(0, -3);

function mediaFile(id, name) {
  if (typeof name !== 'string' || !name || name.startsWith('.') || path.basename(name) !== name || !MEDIA_TYPES[path.extname(name).toLowerCase()]) {
    throw new Error('Bad image name');
  }
  return path.join(mediaDir(id), name);
}

/** Saves an image into the storm's folder under a name of its own, and returns that name. */
function addMedia(id, ext, bytes) {
  const suffix = String(ext).toLowerCase();
  if (!MEDIA_TYPES[suffix]) throw new Error('Not an image');
  const dir = mediaDir(id);
  fs.mkdirSync(dir, { recursive: true });
  let name;
  do {
    name = Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + suffix;
  } while (fs.existsSync(path.join(dir, name)));
  fs.writeFileSync(path.join(dir, name), Buffer.from(bytes));
  return name;
}

/** Puts a file or folder in the Trash. A test run, which must leave the Mac's Trash alone, just removes it. */
const discard = (p) => (process.env.STORM_HEADLESS ? fs.rmSync(p, { recursive: true, force: true }) : shell.trashItem(p));

/** Clears out images nothing points to any more. `refs` maps each storm to the image names it
    still uses. Runs as the app opens, when no Undo could still bring one back. */
async function sweepMedia(refs) {
  if (!fs.existsSync(DIR)) return;
  for (const entry of fs.readdirSync(DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !STORM_ID.test(entry.name)) continue; // only folders the app made
    const dir = path.join(DIR, entry.name);
    const keep = new Set(Array.isArray(refs?.[entry.name]) ? refs[entry.name] : []);
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
    if (!files.some((f) => keep.has(f))) {
      if (files.every((f) => MEDIA_TYPES[path.extname(f).toLowerCase()])) await discard(dir);
      continue;
    }
    for (const f of files) {
      if (!keep.has(f) && MEDIA_TYPES[path.extname(f).toLowerCase()]) await discard(path.join(dir, f));
    }
  }
}

/** Puts one of a storm's images on the clipboard. The clipboard takes PNG: a PNG goes as it
    is, and anything else is converted first. */
async function copyImage(id, name) {
  const file = mediaFile(id, name);
  let png;
  if (path.extname(name).toLowerCase() === '.png') {
    png = fs.readFileSync(file);
  } else {
    const image = nativeImage.createFromPath(file);
    if (image.isEmpty()) throw new Error('Unreadable image');
    png = image.toPNG();
  }
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
}

// ---------- wallpaper setting ----------
// There is no wallpaper until the user picks an image. settings.json then holds
// { kind: 'custom', file, name }, and the image is copied into the app's data folder,
// so the original can move or go.

const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

// ---------- the storms' folder ----------
// settings.json's `dir` is the folder chosen in Settings; without it, storms live in
// Documents/Storms. Choosing a folder moves nothing: the app reads and writes there from then on.

if (!process.env.STORM_DIR) {
  const chosen = readSettings().dir;
  if (typeof chosen === 'string' && path.isAbsolute(chosen)) DIR = chosen;
}

/** The folder as Settings shows it: its path, and the same with the home folder as "~". */
function folder() {
  const home = app.getPath('home');
  return { path: DIR, shown: DIR === home || DIR.startsWith(home + path.sep) ? '~' + DIR.slice(home.length) : DIR };
}

/** Asks for a folder and makes it the storms' folder. Resolves with the folder now in use,
    and whether it changed. A test run takes the folder from STORM_PICK_DIR instead of asking. */
async function chooseFolder() {
  let picked = process.env.STORM_PICK_DIR;
  if (!headless) {
    const asked = await dialog.showOpenDialog(win, {
      title: 'Choose a folder for your storms',
      message: 'Storm keeps one Markdown file per storm in this folder.',
      buttonLabel: 'Use this folder',
      defaultPath: DIR,
      properties: ['openDirectory', 'createDirectory'],
    });
    picked = asked.canceled ? null : asked.filePaths[0];
  }
  if (!picked || path.resolve(picked) === path.resolve(DIR)) return { ...folder(), changed: false };
  fs.mkdirSync(picked, { recursive: true });
  DIR = path.resolve(picked);
  const settings = readSettings();
  if (DIR === DEFAULT_DIR) delete settings.dir;
  else settings.dir = DIR;
  writeSettings(settings);
  return { ...folder(), changed: true };
}

function wallpaper() {
  const w = readSettings().wallpaper;
  if (w?.kind === 'custom' && typeof w.file === 'string' && path.basename(w.file) === w.file) {
    try {
      const mime = IMAGE_TYPES[path.extname(w.file).toLowerCase()];
      const bytes = fs.readFileSync(path.join(app.getPath('userData'), w.file));
      if (mime) return { kind: 'custom', name: String(w.name || w.file), mime, bytes };
    } catch {
      // The copy is gone: carry on without a wallpaper.
    }
  }
  return { kind: 'none' };
}

function setWallpaper(w) {
  writeSettings({ ...readSettings(), wallpaper: w });
  return wallpaper();
}

async function chooseWallpaper() {
  const picked = await dialog.showOpenDialog(win, {
    title: 'Choose a wallpaper',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: Object.keys(IMAGE_TYPES).map((e) => e.slice(1)) }],
  });
  const src = picked.filePaths[0];
  if (picked.canceled || !src) return null;
  const ext = path.extname(src).toLowerCase();
  if (!IMAGE_TYPES[ext]) return null;

  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (/^wallpaper\.[a-z]+$/.test(f)) fs.rmSync(path.join(dir, f));
  }
  fs.copyFileSync(src, path.join(dir, 'wallpaper' + ext));
  return setWallpaper({ kind: 'custom', file: 'wallpaper' + ext, name: path.basename(src) });
}

// ---------- ipc ----------

ipcMain.handle('storms:list', () => list());
ipcMain.handle('storms:save', (_e, id, text, mtime) => save(id, text, mtime));
ipcMain.handle('storms:remove', (_e, id) => remove(id));
ipcMain.handle('folder:get', () => folder());
ipcMain.handle('folder:choose', () => chooseFolder());
ipcMain.handle('folder:show', () => {
  fs.mkdirSync(DIR, { recursive: true });
  return headless ? console.log('SHOW ' + DIR) : shell.openPath(DIR);
});
// About: the version, and the two places the app points to.
const PLACES = { site: 'https://vgnshiyer.me/storm/', source: 'https://github.com/vgnshiyer/storm' };
ipcMain.handle('app:info', () => ({ version: app.getVersion() }));
ipcMain.handle('app:open', (_e, place) => {
  const url = PLACES[place];
  if (url) return headless ? console.log('OPEN ' + url) : shell.openExternal(url);
});
// A test run leaves the Mac's clipboard and browser alone: it only notes what it would have done.
ipcMain.handle('clipboard:write', (_e, text) => (headless ? console.log('COPY ' + JSON.stringify(String(text))) : clipboard.writeText(String(text))));
// Posting: one tweet is handed to X's own composer in the browser. Nothing is posted until
// the Post button is pressed there.
ipcMain.handle('post:open', (_e, text) => {
  const url = 'https://x.com/intent/post?text=' + encodeURIComponent(String(text));
  return headless ? console.log('OPEN ' + url) : shell.openExternal(url);
});
ipcMain.handle('media:add', (_e, id, ext, bytes) => addMedia(id, ext, bytes));
ipcMain.handle('media:read', (_e, id, name) => ({ mime: MEDIA_TYPES[path.extname(String(name)).toLowerCase()], bytes: fs.readFileSync(mediaFile(id, name)) }));
ipcMain.handle('media:copy', (_e, id, name) => (headless ? console.log('COPY-IMAGE ' + path.basename(mediaFile(id, name))) : copyImage(id, name)));
ipcMain.handle('media:sweep', (_e, refs) => sweepMedia(refs));
ipcMain.handle('media:trash', async (_e, id) => {
  const dir = mediaDir(id);
  if (fs.existsSync(dir)) await discard(dir);
});
ipcMain.handle('wallpaper:get', () => wallpaper());
ipcMain.handle('wallpaper:choose', () => chooseWallpaper());
ipcMain.handle('wallpaper:clear', () => setWallpaper({ kind: 'none' }));
// AI. settings.json's `ai` holds the connections that have been made and the model chosen:
// { connections: { claude: { enabled }, … }, model: { provider, id, name }, endpoints: [ … ] }.
// Several can be held at once; each can be switched off without being let go. A provider is
// only held once it has answered, and every request comes back as { ok, … } so the window can
// say what went wrong in the provider's own words.
// `effort` is the reasoning level asked of models that take one: low, medium or high; left
// out, each model thinks as much as it does by itself.
// An endpoint is a model added by its address: { id, name, url, model, modelName, levels, key }. It is
// a connection like the others, under its own id, and offers the one model it was added for.
// Its API key is kept sealed by the Mac's Keychain, and never leaves this process.
function aiSettings() {
  const saved = readSettings().ai || {};
  // Before several could be held, `ai.provider` named the one in use.
  const connections = saved.connections || (ai.has(saved.provider) ? { [saved.provider]: { enabled: true } } : {});
  const endpoints = (Array.isArray(saved.endpoints) ? saved.endpoints : []).filter((e) => e && [e.id, e.url, e.model].every((v) => typeof v === 'string' && v) && ai.address(e.url) === e.url);
  return { connections, model: saved.model || null, endpoints, effort: LEVELS.includes(saved.effort) ? saved.effort : null };
}
const LEVELS = ['low', 'medium', 'high'];
const saveAi = (next) => writeSettings({ ...readSettings(), ai: next });
const aiOn = (s, id) => Boolean(s.connections[id]?.enabled);
const aiEndpoint = (s, id) => s.endpoints.find((e) => e.id === id) || null;
/** Every connection there could be: the tools, then the endpoints in the order they were added. */
const aiIds = (s) => [...ai.list().map((p) => p.id), ...s.endpoints.map((e) => e.id)];
/** The models a connection offers: a tool's own list, or the one model of an endpoint. */
async function aiModels(s, id) {
  const e = aiEndpoint(s, id);
  return e ? [{ id: e.model, name: e.modelName || e.model, usual: true, levels: Array.isArray(e.levels) ? e.levels : [] }] : ai.models(id);
}
/** The reasoning levels on offer for a model: those of ours that it takes. */
async function aiLevels(s, model) {
  const offered = model ? await aiModels(s, model.provider) : [];
  const takes = offered.find((m) => m.id === model.id)?.levels || [];
  return LEVELS.filter((l) => takes.includes(l));
}

async function sealKey(key) {
  if (!key) return '';
  try {
    return (await safeStorage.encryptStringAsync(key)).toString('base64');
  } catch {
    throw new Error('The Keychain is not available to keep the API key.');
  }
}
async function openKey(sealed) {
  if (!sealed) return '';
  try {
    return (await safeStorage.decryptStringAsync(Buffer.from(sealed, 'base64'))).result;
  } catch {
    throw new Error('The API key could not be read from the Keychain.');
  }
}

/** An endpoint as the Add dialog sends it, made fit to use: its address made whole, and its
    key. A key left empty while changing a held endpoint means the key already kept, but only
    while the address is the one that key was given for. Throws a line if it cannot be used. */
async function aiDraft(draft) {
  const s = aiSettings();
  const held = aiEndpoint(s, String(draft?.id || ''));
  const url = ai.address(draft?.url);
  if (!url) throw new Error('That is not an address.');
  const typed = String(draft?.key || '').trim();
  const key = typed || (held && held.url === url ? await openKey(held.key) : '');
  const model = String(draft?.model || '').trim();
  return { id: held?.id, url, key, model };
}

/** The model requests go to: the one chosen, while its provider is held and switched on;
    failing that, the usual model of the first provider that is. Null when none is. */
async function aiModel(s = aiSettings()) {
  if (s.model && aiOn(s, s.model.provider)) {
    // A choice the provider no longer lists (its models were renamed or retired) gives way to its usual one.
    const offered = await aiModels(s, s.model.provider);
    if (!offered.length || offered.some((m) => m.id === s.model.id)) return s.model;
  }
  const chosenFirst = aiIds(s).sort((x, y) => (y === s.model?.provider) - (x === s.model?.provider));
  for (const id of chosenFirst) {
    const usual = aiOn(s, id) && (await aiModels(s, id)).find((m) => m.usual);
    if (usual) return { provider: id, id: usual.id, name: usual.name };
  }
  return null;
}

/** Everything the AI page draws: each provider with what is known of its tool (once this Mac
    has been looked over), whether it is held and switched on, and its models; after them the
    endpoints (`api: true`), without their keys; the ready-made addresses; the model in use;
    the reasoning level chosen (`effort`), and the levels the model in use takes (`levels`). */
let aiSeen = null; // the last look over this Mac
async function aiView() {
  const s = aiSettings();
  const tools = await Promise.all((aiSeen || ai.list()).map(async (p) => ({ ...p, connected: Boolean(s.connections[p.id]), enabled: aiOn(s, p.id), models: await ai.models(p.id) })));
  const apis = await Promise.all(
    s.endpoints.map(async (e) => ({ id: e.id, api: true, ...ai.place(e.url), url: e.url, model: e.model, hasKey: Boolean(e.key), connected: true, enabled: aiOn(s, e.id), models: await aiModels(s, e.id) }))
  );
  const model = await aiModel(s);
  return { providers: [...tools, ...apis], presets: ai.presets, model, effort: s.effort, levels: await aiLevels(s, model) };
}
const asking = new Map(); // request key → the means to call it off
/** Runs one cancellable piece of work under `key`. Called off, it resolves `{ ok: false, cancelled: true }`. */
async function cancellable(key, work) {
  const stop = new AbortController();
  asking.set(key, stop);
  try {
    const result = await work(stop.signal);
    return stop.signal.aborted ? { ok: false, cancelled: true } : result;
  } catch (e) {
    return stop.signal.aborted ? { ok: false, cancelled: true } : { ok: false, error: e.message };
  } finally {
    asking.delete(key);
  }
}
ipcMain.handle('ai:list', () => aiView());
ipcMain.handle('ai:status', async () => {
  aiSeen = await ai.inspect();
  await Promise.all(aiSeen.map((p) => ai.models(p.id, true)));
  return aiView();
});
ipcMain.handle('ai:signin', (_e, key, id) => cancellable(key, (signal) => ai.signIn(id, { signal })));
ipcMain.handle('ai:connect', async (_e, key, id) => {
  const result = await cancellable(key, (signal) => ai.check(id, { signal }));
  if (result.ok) {
    // The model in use stays the model in use: a connection added beside it does not take over.
    const s = aiSettings();
    saveAi({ ...s, connections: { ...s.connections, [id]: { enabled: true } }, model: await aiModel(s) });
  }
  return result;
});
// The models an address lists, for the Add dialog to offer while its model is being typed.
ipcMain.handle('ai:endpoint:models', (_e, key, draft) => cancellable(key, async (signal) => ({ ok: true, models: await ai.endpointModels(await aiDraft(draft), { signal }) })));
// Adds an endpoint, or changes a held one, once its model has answered.
ipcMain.handle('ai:endpoint:save', (_e, key, draft) =>
  cancellable(key, async (signal) => {
    const { id = `api-${Date.now().toString(36)}`, ...endpoint } = await aiDraft(draft);
    // The key is sealed before anything is sent: a key that cannot be kept is not tried.
    const sealed = await sealKey(endpoint.key);
    if (!endpoint.model) return { ok: false, error: 'Name a model.' };
    const result = await ai.checkEndpoint(endpoint, { signal });
    if (!result.ok) return result;
    // What the address says of the model, where it says anything: its full name, and the reasoning levels it takes.
    const listed = (await ai.endpointModels(endpoint, { signal }).catch(() => [])).find((m) => m.id === endpoint.model);
    const s = aiSettings();
    const kept = { id, name: ai.place(endpoint.url).name, url: endpoint.url, model: endpoint.model, modelName: listed?.name || endpoint.model, levels: listed?.levels || [], key: sealed };
    const endpoints = s.endpoints.some((e) => e.id === id) ? s.endpoints.map((e) => (e.id === id ? kept : e)) : [...s.endpoints, kept];
    const next = { ...s, endpoints, connections: { ...s.connections, [id]: { enabled: s.connections[id]?.enabled ?? true } } };
    saveAi({ ...next, model: await aiModel(next) });
    return result;
  })
);
ipcMain.handle('ai:enable', (_e, id, on) => {
  const s = aiSettings();
  if (s.connections[id]) saveAi({ ...s, connections: { ...s.connections, [id]: { enabled: Boolean(on) } } });
  return aiView();
});
// Letting a connection go only makes Storm forget it: the tool stays signed in for its own
// use. An endpoint is forgotten whole, its key with it.
ipcMain.handle('ai:disconnect', (_e, id) => {
  const s = aiSettings();
  const { [id]: gone, ...connections } = s.connections;
  saveAi({ ...s, connections, model: s.model?.provider === id ? null : s.model, endpoints: s.endpoints.filter((e) => e.id !== id) });
  return aiView();
});
ipcMain.handle('ai:model', async (_e, provider, id) => {
  const s = aiSettings();
  const model = (await aiModels(s, provider)).find((m) => m.id === id);
  if (model && aiOn(s, provider)) saveAi({ ...s, model: { provider, id: model.id, name: model.name } });
  return aiView();
});
ipcMain.handle('ai:effort', (_e, level) => {
  saveAi({ ...aiSettings(), effort: LEVELS.includes(level) ? level : null });
  return aiView();
});
ipcMain.handle('ai:page', (_e, id) => {
  const url = ai.pageOf(id);
  if (url) return headless ? console.log('OPEN ' + url) : shell.openExternal(url);
});
// While a reply is on its way, its words so far go to the window that asked, as 'ai:text'
// with the request's key: at most one a moment, each the whole reply so far.
ipcMain.handle('ai:ask', (e, key, request) =>
  cancellable(key, async (signal) => {
    let latest = null;
    let due = null;
    const onText = (text) => {
      latest = text;
      due ??= setTimeout(() => {
        due = null;
        if (!signal.aborted && !e.sender.isDestroyed()) e.sender.send('ai:text', key, latest);
      }, 40);
    };
    const s = aiSettings();
    const model = await aiModel(s);
    if (!model) return { ok: false, error: 'No AI is connected.' };
    const endpoint = aiEndpoint(s, model.provider);
    const effort = (await aiLevels(s, model)).includes(s.effort) ? s.effort : undefined; // only where the model takes it
    try {
      const text = endpoint
        ? await ai.askEndpoint({ ...endpoint, key: await openKey(endpoint.key) }, request, { signal, effort, onText })
        : await ai.ask(model.provider, request, { signal, model: model.id, effort, onText });
      return { ok: true, text, model: model.name };
    } finally {
      clearTimeout(due); // the whole reply follows: no words after it
    }
  })
);
ipcMain.handle('ai:cancel', (_e, key) => asking.get(key)?.abort());

// The last reply about each tweet is kept in the app's own data, apart from the storms'
// files: asks.json holds { storm id: { tweet number: { question, reply, model } } }.
const asksFile = () => path.join(app.getPath('userData'), 'asks.json');
function readAsks() {
  try {
    const kept = JSON.parse(fs.readFileSync(asksFile(), 'utf8'));
    return kept && typeof kept === 'object' && !Array.isArray(kept) ? kept : {};
  } catch {
    return {};
  }
}
ipcMain.handle('asks:load', () => readAsks());
ipcMain.handle('asks:clear', () => fs.rmSync(asksFile(), { force: true }));
/** Replaces what is kept for one storm; with nothing to keep, the storm is dropped from the file. */
ipcMain.handle('asks:save', (_e, id, kept) => {
  const all = readAsks();
  if (kept && typeof kept === 'object' && Object.keys(kept).length) all[String(id)] = kept;
  else delete all[String(id)];
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(asksFile(), JSON.stringify(all));
});
ipcMain.on('storms:saveSync', (e, id, text, mtime) => {
  try {
    save(id, text, mtime);
    e.returnValue = true;
  } catch {
    e.returnValue = false;
  }
});

// ---------- window and menu ----------

let win = null;

// A test run can keep its window off the screen (STORM_HEADLESS=1), so it neither gets
// in the way of whoever is at the Mac nor picks up their pointer.
const headless = Boolean(process.env.STORM_HEADLESS);

function createWindow() {
  win = new BrowserWindow({
    show: !headless,
    width: 1100,
    height: 720,
    minWidth: 640,
    minHeight: 400,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 15 },
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: !headless,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

/** A menu item that hands its action to the window, opening one first if none is open. */
function action(label, accelerator, name) {
  return {
    label,
    accelerator,
    click: () => {
      if (win) win.webContents.send('menu', name);
      else createWindow();
    },
  };
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          action('Settings…', 'Cmd+P', 'settings'),
          { ...action('Settings…', 'Cmd+,', 'settings'), visible: false }, // the Mac's usual shortcut still works
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'File',
        submenu: [action('New Storm', 'Cmd+N', 'new-storm'), action('New Tab', 'Cmd+T', 'open-tab'), { type: 'separator' }, action('Post to X…', 'Shift+Cmd+Enter', 'post'), { type: 'separator' }, action('Close Tab', 'Cmd+W', 'close-tab')],
      },
      {
        label: 'Edit',
        // Undo and Redo go to the window, which steps through the storm's own history
        // (splits, merges, deletions and moves included), not just one field's typing.
        submenu: [
          action('Undo', 'Cmd+Z', 'undo'),
          action('Redo', 'Shift+Cmd+Z', 'redo'),
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
          { type: 'separator' },
          action('Ask About This Tweet…', 'Cmd+K', 'ask'),
        ],
      },
      {
        label: 'View',
        submenu: [
          action('Toggle Sidebar', 'Cmd+B', 'toggle-sidebar'),
          action('Find in Storm', 'Cmd+F', 'find'),
          action('Search Storms', 'Shift+Cmd+F', 'search'),
          action('Show Next Tab', 'Ctrl+Tab', 'next-tab'),
          action('Show Previous Tab', 'Ctrl+Shift+Tab', 'previous-tab'),
          { type: 'separator' },
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ])
  );
  // Run from source, the Dock would show Electron's own icon; a packaged app carries its icon itself.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  createWindow();
  app.on('activate', () => {
    if (!win) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
