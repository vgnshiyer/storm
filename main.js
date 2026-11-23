const { app, BrowserWindow, Menu, ipcMain, clipboard, ClipboardItem, shell, dialog, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const ai = require('./ai');

// One Markdown file per storm, in Documents/Storms. STORM_DIR overrides the folder and keeps the app's own
// state beside it, so a test run never touches the real storms or settings.
const DIR = process.env.STORM_DIR || path.join(app.getPath('documents'), 'Storms');
if (process.env.STORM_DIR) app.setPath('userData', path.join(DIR, '.userdata'));

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
// { connections: { claude: { enabled }, … }, model: { provider, id, name } }. Several can be
// held at once; each can be switched off without being let go. A provider is only held once it
// has answered, and every request comes back as { ok, … } so the window can say what went
// wrong in the provider's own words.
function aiSettings() {
  const saved = readSettings().ai || {};
  // Before several could be held, `ai.provider` named the one in use.
  const connections = saved.connections || (ai.has(saved.provider) ? { [saved.provider]: { enabled: true } } : {});
  return { connections, model: saved.model || null };
}
const saveAi = (next) => writeSettings({ ...readSettings(), ai: next });
const aiOn = (s, id) => Boolean(s.connections[id]?.enabled);

/** The model requests go to: the one chosen, while its provider is held and switched on;
    failing that, the usual model of the first provider that is. Null when none is. */
async function aiModel(s = aiSettings()) {
  if (s.model && aiOn(s, s.model.provider)) {
    // A choice the provider no longer lists (its models were renamed or retired) gives way to its usual one.
    const offered = await ai.models(s.model.provider);
    if (!offered.length || offered.some((m) => m.id === s.model.id)) return s.model;
  }
  const chosenFirst = [...ai.list()].sort((x, y) => (y.id === s.model?.provider) - (x.id === s.model?.provider));
  for (const p of chosenFirst) {
    const usual = aiOn(s, p.id) && (await ai.models(p.id)).find((m) => m.usual);
    if (usual) return { provider: p.id, id: usual.id, name: usual.name };
  }
  return null;
}

/** Everything the AI page draws: each provider with what is known of its tool (once this Mac
    has been looked over), whether it is held and switched on, and its models; and the model in use. */
let aiSeen = null; // the last look over this Mac
async function aiView() {
  const s = aiSettings();
  const providers = await Promise.all((aiSeen || ai.list()).map(async (p) => ({ ...p, connected: Boolean(s.connections[p.id]), enabled: aiOn(s, p.id), models: await ai.models(p.id) })));
  return { providers, model: await aiModel(s) };
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
    saveAi({ connections: { ...s.connections, [id]: { enabled: true } }, model: await aiModel(s) });
  }
  return result;
});
ipcMain.handle('ai:enable', (_e, id, on) => {
  const s = aiSettings();
  if (s.connections[id]) saveAi({ ...s, connections: { ...s.connections, [id]: { enabled: Boolean(on) } } });
  return aiView();
});
// Letting a connection go only makes Storm forget it: the tool stays signed in for its own use.
ipcMain.handle('ai:disconnect', (_e, id) => {
  const s = aiSettings();
  const { [id]: gone, ...connections } = s.connections;
  saveAi({ connections, model: s.model?.provider === id ? null : s.model });
  return aiView();
});
ipcMain.handle('ai:model', async (_e, provider, id) => {
  const s = aiSettings();
  const model = (await ai.models(provider)).find((m) => m.id === id);
  if (model && aiOn(s, provider)) saveAi({ ...s, model: { provider, id: model.id, name: model.name } });
  return aiView();
});
ipcMain.handle('ai:page', (_e, id) => {
  const url = ai.pageOf(id);
  if (url) return headless ? console.log('OPEN ' + url) : shell.openExternal(url);
});
ipcMain.handle('ai:ask', (_e, key, request) =>
  cancellable(key, async (signal) => {
    const model = await aiModel();
    if (!model) return { ok: false, error: 'No AI is connected.' };
    return { ok: true, text: await ai.ask(model.provider, request, { signal, model: model.id }), model: model.name };
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
