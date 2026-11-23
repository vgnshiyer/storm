const { app, BrowserWindow, Menu, ipcMain, clipboard, ClipboardItem, shell, dialog, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

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
