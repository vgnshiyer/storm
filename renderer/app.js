import { Wallpaper } from './wallpaper.js';

// What a tweet holds: 280, or 25,000 for an X Premium account. Chosen in Settings.
const LIMITS = [280, 25000];
let LIMIT = LIMITS.find((n) => String(n) === localStorage.getItem('limit')) ?? LIMITS[0];
const URL_LENGTH = 23;
const SEP = '\n\n---\n\n';
const LINE_HEIGHT = 24;

const $ = (id) => document.getElementById(id);

// The size of a storm's words, also chosen in Settings. Every size keeps the 24px line.
const TEXT_SIZES = [
  ['small', 'Small', 14],
  ['medium', 'Medium', 15],
  ['large', 'Large', 17],
];
function applyTextSize() {
  const [id, , px] = TEXT_SIZES.find(([size]) => size === localStorage.getItem('text-size')) ?? TEXT_SIZES[1];
  document.documentElement.style.setProperty('--write-size', px + 'px');
  return id;
}
applyTextSize();
const listEl = $('list');
let query = ''; // what the sidebar's search field holds, in lower case; empty when not searching
const tabsEl = $('tabs');
const tweetsEl = $('tweets');
const statusEl = $('status');
const measureEl = $('measure');

/** `media[i]` lists the images on tweet i, by file name in the storm's own folder.
    @typedef {{id: string, name: string, tweets: string[], media: string[][], mtime: number, onDisk: boolean}} Storm */
/** @type {Storm[]} Every storm on disk, plus any blank ones open in a tab. */
let storms = [];
/** @type {Storm[]} The storms open as tabs, left to right. */
let tabs = [];
let active = 0;
/** @type {Storm | null} The storm in the active tab: the one on screen. */
let cur = null;
let dirty = false;
let saveTimer = null;
let hasWallpaper = false;

// ---------- file format ----------
// Tweets are separated by a `---` line. A tweet's own `---` line is stored as `\---`.
// A storm that has been given a name starts with it, as a `# Name` heading and a blank line.
// An unnamed storm whose first words are `# ` has them stored as `\# `, so they are not read
// back as a name.
// A tweet's images follow its words, after a blank line, as Markdown image lines pointing
// into the storm's folder: `![](storm-id/file.png)`. A line of the tweet's own that looks like
// one is stored as `\![](…)`.

const IMAGE_LINES = /(?:^|\n\n)((?:!\[\]\([^)\n]+\)(?:\n|$))+)$/;

function serialize(s) {
  const body = s.tweets
    .map((t, i) => {
      const text = t.replace(/^(\\*)---$/gm, '\\$1---').replace(/^(\\*)!\[\]\(/gm, '\\$1![](');
      const images = s.media[i].map((file) => `![](${s.id}/${file})`).join('\n');
      return images && text ? `${text}\n\n${images}` : images || text;
    })
    .join(SEP);
  return (s.name ? `# ${s.name}\n\n${body}` : body.replace(/^(\\*)# /, '\\$1# ')) + '\n';
}

function parse(text) {
  let body = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  let name = '';
  const heading = /^# ([^\n]*)(\n\n|$)/.exec(body);
  if (heading) {
    name = cleanName(heading[1]);
    body = body.slice(heading[0].length);
  } else {
    body = body.replace(/^\\(\\*# )/, '$1');
  }
  const media = [];
  const tweets = body.split(SEP).map((chunk) => {
    const images = IMAGE_LINES.exec(chunk);
    media.push(images ? images[1].trim().split('\n').map((line) => line.slice(4, -1).split('/').pop()) : []);
    const text = images ? chunk.slice(0, images.index) : chunk;
    return text.replace(/^\\(\\*---)$/gm, '$1').replace(/^\\(\\*!\[\]\()/gm, '$1');
  });
  return { name, tweets, media };
}

const NAME_MAX = 80;
const cleanName = (raw) => raw.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

// ---------- counting ----------
// Follows X's weighting: links count 23, emoji 2, most Latin text 1, CJK and the rest 2.

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const URL_RE = /https?:\/\/[^\s]+/gi;
const EMOJI_RE = /\p{Extended_Pictographic}/u;

function codePointWeight(cp) {
  return cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247) ? 1 : 2;
}

function graphemeWeight(g) {
  if (EMOJI_RE.test(g)) return 2;
  let w = 0;
  for (const ch of g) w += codePointWeight(ch.codePointAt(0));
  return w;
}

/** Returns the weighted length and the string index where the tweet first goes over (or -1). */
function measure(raw) {
  const text = raw.trimEnd();
  let count = 0;
  let overAt = -1;
  const add = (weight, index) => {
    count += weight;
    if (overAt < 0 && count > LIMIT) overAt = index;
  };
  const plain = (from, to) => {
    for (const s of segmenter.segment(text.slice(from, to))) add(graphemeWeight(s.segment), from + s.index);
  };
  let pos = 0;
  for (const m of text.matchAll(URL_RE)) {
    plain(pos, m.index);
    add(URL_LENGTH, m.index);
    pos = m.index + m[0].length;
  }
  plain(pos, text.length);
  return { count, overAt };
}

// ---------- helpers ----------

/** Nothing written yet. The wallpaper, the resting buttons and the count go by this. */
const hasContent = (s, i) => Boolean(s.tweets[i].trim() || s.media[i].length);
const isEmpty = (s) => !s.tweets.some((_, i) => hasContent(s, i));
/** Nothing to keep: no words and no name. Such a storm has no file and no place in the list. */
const isBlank = (s) => isEmpty(s) && !s.name;
const tweetCount = (s) => s.tweets.filter((_, i) => hasContent(s, i)).length;

// Numbering, when it is switched on in Settings: each tweet goes out with its place in the
// storm before its words ("3/ …"). A storm of one, and a tweet with no words (only images),
// are left as they are.
if (localStorage.getItem('number-style')) {
  // A style and a position could be chosen for a while. Any style at all now means "on".
  if (localStorage.getItem('number-style') === 'off') localStorage.removeItem('number-tweets');
  else localStorage.setItem('number-tweets', '1');
  localStorage.removeItem('number-style');
  localStorage.removeItem('number-place');
}
const numbering = () => localStorage.getItem('number-tweets') === '1';

/** What tweet `i` starts with: "3/ ", or '' if it goes without a number. */
function numberOf(s, i) {
  if (!numbering() || !s.tweets[i].trim()) return '';
  const order = s.tweets.flatMap((_, k) => (hasContent(s, k) ? [k] : []));
  return order.length > 1 ? `${order.indexOf(i) + 1}/ ` : '';
}

/** A tweet as it leaves the app: its number, if tweets are numbered, and its words. */
const outgoing = (s, i) => numberOf(s, i) + s.tweets[i].trim();

/** How long tweet `i` is as it leaves the app, and where in its own words it first goes over. */
function measureOutgoing(s, i) {
  const number = numberOf(s, i);
  const { count, overAt } = measure(number + s.tweets[i].trimEnd());
  return { count, overAt: overAt < 0 ? overAt : Math.max(0, overAt - number.length) };
}
const plural = (n) => `${n} tweet${n === 1 ? '' : 's'}`;

/** A storm goes by its name, or failing that by its first line. */
function titleOf(s) {
  if (s.name) return s.name;
  for (const t of s.tweets) {
    const line = t.split('\n').find((l) => l.trim());
    if (line) return line.trim();
  }
  return 'New storm';
}

function relTime(ms) {
  const diff = Date.now() - ms;
  if (diff < 60e3) return 'now';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + 'm';
  const d = new Date(ms);
  if (d.toDateString() === new Date().toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (diff < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  let id = base;
  for (let n = 2; storms.some((s) => s.id === id); n++) id = `${base}-${n}`;
  return id;
}

function blankStorm() {
  const s = { id: newId(), name: '', tweets: [''], media: [[]], mtime: Date.now(), onDisk: false };
  storms.push(s);
  return s;
}

/** The settings tab. Every other tab holds a storm. */
const SETTINGS = { id: '::settings' };
const isStorm = (tab) => tab !== SETTINGS;

/** Forgets a storm that holds nothing and is no longer open anywhere. */
function drop(s) {
  if (s && isStorm(s) && isBlank(s) && !tabs.includes(s)) storms = storms.filter((x) => x !== s);
}

/** The speech bubble that marks a storm's tab (Lucide "message-circle"). */
const STORM_ICON = 'M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719';

// Lucide "copy" (corners rounded further) and "check".
const COPY_ICON = 'M11.5 8h7a3.5 3.5 0 0 1 3.5 3.5v7a3.5 3.5 0 0 1-3.5 3.5h-7A3.5 3.5 0 0 1 8 18.5v-7A3.5 3.5 0 0 1 11.5 8zM4.5 16A2.5 2.5 0 0 1 2 13.500V5.5A3.5 3.5 0 0 1 5.5 2h8A2.5 2.5 0 0 1 16 4.500';
const CHECK_ICON = 'M20 6 9 17l-5-5';

/** A small line icon drawn from an SVG path, so it sits dead centre in its button. */
function icon(path, size, box = 16) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${box} ${box}`);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', box === 24 ? '1.9' : '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---------- saving ----------

let flashUntil = 0;

/** Says something in the status line for a moment, then lets it go back to what it was. */
function flash(text) {
  statusEl.classList.remove('error');
  statusEl.textContent = text;
  flashUntil = Date.now() + 2600;
  setTimeout(() => {
    if (Date.now() >= flashUntil) setStatus(dirty ? 'saving' : 'saved');
  }, 2650);
}

function setStatus(state) {
  if (state !== 'error' && Date.now() < flashUntil) return; // a message is up: it has the line for now
  statusEl.classList.toggle('error', state === 'error');
  if (state === 'error') statusEl.textContent = "Couldn't save. Keep this window open.";
  else if (!cur || isEmpty(cur)) statusEl.textContent = '';
  else statusEl.textContent = `${plural(tweetCount(cur))} · ${state === 'saving' ? 'saving…' : 'saved'}`;
}

/** Call after any change to the open storm. */
function touch() {
  cur.mtime = Date.now();
  dirty = true;
  setStatus('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 300);
  renderList();
  const tab = tabsEl.children[active];
  if (tab.classList.contains('blank') !== isBlank(cur)) renderTabs(); // the icon comes or goes
  else tab.querySelector('.tab-title').textContent = titleOf(cur);
  updateWall();
  syncHints();
  syncHistory();
}

/** Puts a storm on disk as it stands now, or takes its file away if there is nothing to keep. */
async function write(s) {
  if (isBlank(s)) {
    if (s.onDisk) await window.api.remove(s.id);
    s.onDisk = false;
  } else {
    await window.api.save(s.id, serialize(s), s.mtime);
    s.onDisk = true;
  }
}

async function flush() {
  clearTimeout(saveTimer);
  if (!dirty || !cur) return;
  dirty = false;
  const s = cur;
  try {
    await write(s);
    if (!dirty && s === cur) setStatus('saved');
  } catch {
    if (s === cur) {
      dirty = true;
      setStatus('error');
    }
  }
}

window.addEventListener('beforeunload', () => {
  if (!dirty || !cur) return;
  if (isBlank(cur)) {
    if (cur.onDisk) window.api.remove(cur.id);
  } else {
    window.api.saveSync(cur.id, serialize(cur), cur.mtime);
  }
});

// ---------- tabs ----------

// ---------- dragging things into a new order ----------

const SORT_SLOP = 4; // px the pointer must travel before a press becomes a drag
const SORT_EDGE = 56; // px from the scroller's top or bottom where a drag starts to scroll it

/** Lets `item` be dragged to a new place among its siblings, along a row ('x') or a column
    ('y'). The others slide aside to show where it will land; on release it settles there and
    `onDrop(from, to)` is told. A press that never travels is left alone, so clicks still work.
    With a `scroller`, holding the drag near its edge (top or bottom for a column, left or
    right for a row) scrolls it. */
function startSort(e, item, { axis, scroller, onDrop }) {
  const list = [...item.parentElement.children];
  const from = list.indexOf(item);
  if (e.button !== 0 || list.length < 2) return;
  const across = axis === 'x';
  const rects = list.map((el) => el.getBoundingClientRect());
  const lead = (r) => (across ? r.left : r.top);
  const size = (r) => (across ? r.width : r.height);
  const gap = lead(rects[1]) - lead(rects[0]) - size(rects[0]);
  const move = (d) => (d ? (across ? `translateX(${d}px)` : `translateY(${d}px)`) : '');
  const least = lead(rects[0]) - lead(rects[from]);
  const most = lead(rects.at(-1)) + size(rects.at(-1)) - lead(rects[from]) - size(rects[from]);
  const start = across ? e.clientX : e.clientY;
  const scrollAt = () => (across ? scroller.scrollLeft : scroller.scrollTop);
  const scrolled = scroller ? scrollAt() : 0;
  let pointer = start;
  let to = from;
  let dragging = false;
  let frame = 0;

  /** How far the dragged item sits from its slot once it has landed at `to`. */
  const landing = () => {
    let d = 0;
    for (let j = from + 1; j <= to; j++) d += size(rects[j]) + gap;
    for (let j = to; j < from; j++) d -= size(rects[j]) + gap;
    return d;
  };

  const place = () => {
    const d = Math.max(least, Math.min(most, pointer - start + (scroller ? scrollAt() - scrolled : 0)));
    item.style.transform = move(d);
    const head = lead(rects[from]) + d;
    const tail = head + size(rects[from]);
    to = from;
    for (let j = from + 1; j < list.length; j++) if (tail > lead(rects[j]) + size(rects[j]) / 2) to = j;
    for (let j = from - 1; j >= 0; j--) if (head < lead(rects[j]) + size(rects[j]) / 2) to = j;
    const room = size(rects[from]) + gap;
    list.forEach((el, j) => {
      if (j !== from) el.style.transform = move(j > from && j <= to ? -room : j < from && j >= to ? room : 0);
    });
  };

  // Near the scroller's edge it creeps along, faster the closer the pointer is.
  const creep = () => {
    frame = 0;
    if (!dragging) return;
    const box = scroller.getBoundingClientRect();
    const [near, far] = across ? [box.left, box.right] : [box.top, box.bottom];
    const over = Math.max(0, pointer - (far - SORT_EDGE)) - Math.max(0, near + SORT_EDGE - pointer);
    if (over) {
      const by = Math.max(-16, Math.min(16, over / 4));
      if (across) scroller.scrollLeft += by;
      else scroller.scrollTop += by;
      place();
    }
    frame = requestAnimationFrame(creep);
  };

  const onMove = (ev) => {
    pointer = across ? ev.clientX : ev.clientY;
    if (!dragging) {
      if (Math.abs(pointer - start) < SORT_SLOP) return;
      dragging = true;
      hideTip();
      document.body.classList.add('sorting');
      item.parentElement.classList.add('sorting');
      item.classList.add('dragging');
      if (scroller) frame = requestAnimationFrame(creep);
    }
    place();
  };

  const finish = () => {
    item.removeEventListener('pointermove', onMove);
    item.removeEventListener('pointerup', finish);
    item.removeEventListener('pointercancel', finish);
    cancelAnimationFrame(frame);
    if (!dragging) return;
    dragging = false;
    // The press ends as a drop, not as a click on whatever is under the pointer.
    const swallow = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 80);
    item.classList.add('settling');
    item.style.transform = move(landing());
    setTimeout(() => {
      for (const el of list) el.style.transform = '';
      item.classList.remove('dragging', 'settling');
      item.parentElement.classList.remove('sorting');
      document.body.classList.remove('sorting');
      if (to !== from) onDrop(from, to);
    }, 170);
  };

  item.setPointerCapture(e.pointerId);
  item.addEventListener('pointermove', onMove);
  item.addEventListener('pointerup', finish);
  item.addEventListener('pointercancel', finish);
}

/** Where index `i` ends up once the item at `from` has been moved to `to`. */
const movedIndex = (i, from, to) => (i === from ? to : i > from && i <= to ? i - 1 : i < from && i >= to ? i + 1 : i);

function saveTabs() {
  localStorage.setItem('tabs', JSON.stringify({ ids: tabs.map((s) => s.id), active }));
}

function renderTabs() {
  tabsEl.replaceChildren(
    ...tabs.map((s, i) => {
      const tab = el('div', 'tab' + (i === active ? ' current' : ''));
      const close = el('button', 'tab-close');
      close.append(icon('M4.5 4.5l7 7M11.5 4.5l-7 7', 12));
      close.dataset.tip = 'Close tab';
      close.dataset.keys = '⌘W';
      close.setAttribute('aria-label', 'Close tab');
      // A storm wears a speech bubble, one not yet started the new-storm icon, and settings its own icon.
      const blank = isStorm(s) && isBlank(s);
      const source = blank ? $('new') : isStorm(s) ? null : $('open-settings');
      const glyph = source ? source.querySelector('svg').cloneNode(true) : icon(STORM_ICON, 14, 24);
      glyph.setAttribute('width', 14);
      glyph.setAttribute('height', 14);
      glyph.classList.add('tab-icon');
      tab.append(glyph);
      tab.classList.toggle('blank', blank);
      tab.append(el('span', 'tab-title', isStorm(s) ? titleOf(s) : 'Settings'), close);
      tab.addEventListener('click', (e) => {
        if (close.contains(e.target)) closeTab(i);
        else show(i);
      });
      // Tabs can be dragged along the bar into a new order.
      tab.addEventListener('pointerdown', (e) => {
        if (close.contains(e.target)) return;
        startSort(e, tab, {
          axis: 'x',
          onDrop: (from, to) => {
            tabs.splice(to, 0, ...tabs.splice(from, 1));
            active = movedIndex(active, from, to);
            renderTabs();
            saveTabs();
          },
        });
      });
      return tab;
    })
  );
}

/** Puts tab i on screen: a storm in the editor, or the settings page. */
function show(i) {
  flush();
  // Going to another tab is a cut. The page's eased changes (the sheet opening out, the
  // wallpaper fading) belong to a storm being started, and would otherwise replay on words
  // that are already written, re-wrapping them as the sheet widened.
  document.body.classList.add('switching');
  active = i;
  cur = isStorm(tabs[i]) ? tabs[i] : null;
  stopPosting(); // posting belongs to the storm that was on screen
  if (!cur) closeFind(false); // the settings page has nothing to find in
  document.body.classList.toggle('in-settings', !cur);
  renderTabs();
  renderList();
  if (cur) renderTweets();
  else renderSettings();
  setStatus('saved');
  syncHistory();
  updateWall();
  if (cur) focusTweet(cur.tweets.length - 1, Infinity);
  saveTabs();
  void document.body.offsetWidth; // the new tab's layout is settled before easing comes back
  document.body.classList.remove('switching');
}

/** Opens a storm from the sidebar: jumps to its tab if it has one, else loads it into this tab. */
function openStorm(s) {
  const at = tabs.indexOf(s);
  if (at >= 0) return show(at);
  if (!cur) {
    // The settings tab stays; the storm gets a tab of its own.
    tabs.push(s);
    return show(tabs.length - 1);
  }
  flush();
  const old = cur;
  tabs[active] = s;
  drop(old);
  show(active);
}

function newStorm() {
  if (cur && isBlank(cur)) return focusTweet(0, 0);
  // A blank storm already open in another tab is the new storm: go to it rather than add one.
  const blank = tabs.findIndex((s) => isStorm(s) && isBlank(s));
  if (blank >= 0) return show(blank);
  tabs.push(blankStorm());
  show(tabs.length - 1);
}

function closeTab(i) {
  const s = tabs[i];
  if (tabs.length === 1) {
    // The last tab: a blank storm closes the window; anything else makes way for a blank storm.
    if (isStorm(s) && isBlank(s)) return window.close();
    flush();
    tabs[0] = blankStorm();
    return show(0);
  }
  if (i === active) flush();
  tabs.splice(i, 1);
  drop(s);
  if (i < active) active--;
  else if (active >= tabs.length) active = tabs.length - 1;
  show(active);
}

// The tab bar's + lists the storms that aren't open yet; picking one opens it in a new tab.
const pickerEl = $('picker');

pickerEl.addEventListener('beforetoggle', (e) => {
  if (e.newState !== 'open') return;
  const closed = storms.filter((s) => !isBlank(s) && !tabs.includes(s)).sort((a, b) => b.mtime - a.mtime);
  pickerEl.replaceChildren(
    el('div', 'picker-label', 'Open in a new tab'),
    ...closed.map((s) => {
      const row = el('button', 'picker-row');
      row.type = 'button';
      row.append(el('span', 'picker-title', titleOf(s)), el('span', 'picker-meta', `${plural(tweetCount(s))} · ${relTime(s.mtime)}`));
      row.addEventListener('click', () => {
        pickerEl.hidePopover();
        tabs.push(s);
        show(tabs.length - 1);
      });
      return row;
    })
  );
  const anchor = $('open-tab').getBoundingClientRect();
  pickerEl.style.left = Math.max(8, Math.min(anchor.left, window.innerWidth - 308)) + 'px';
  pickerEl.style.top = anchor.bottom + 6 + 'px';
});

function togglePicker() {
  if ($('open-tab').disabled) return;
  pickerEl.togglePopover();
  pickerEl.querySelector('.picker-row')?.focus();
}

function cycleTab(step) {
  if (tabs.length > 1) show((active + step + tabs.length) % tabs.length);
}

// ---------- sidebar ----------

/** Three dots (Lucide "ellipsis"), drawn as round-capped specks. */
const DOTS_ICON = 'M5 12h.01M12 12h.01M19 12h.01';
const menuEl = $('row-menu');
/** @type {Storm | null} The storm whose three-dots menu is open. */
let menuFor = null;
/** @type {Storm | null} The storm whose name is being typed in the sidebar. */
let renaming = null;

function renderList() {
  if (renaming) return; // leave the name being typed alone; the list catches up once it is done
  const written = storms.filter((s) => !isBlank(s)).sort((a, b) => b.mtime - a.mtime);
  // The tab bar's + has nothing to offer once every storm is open in a tab.
  $('open-tab').disabled = written.every((s) => tabs.includes(s));
  const shown = query ? written.filter(matches) : written;
  listEl.replaceChildren(...shown.map(buildRow));
  if (query && !shown.length) listEl.append(el('div', 'side-empty', 'No storms found'));
}

// ---------- search: the magnifier swaps the logo for a field that filters the list ----------

const searchEl = $('search');
const searchToggle = $('search-toggle');
const headEl = searchEl.closest('.side-head');
let searchBack = null; // what had the caret before, so Escape can hand it back

/** A storm matches when its name or any of its tweets contains the words typed. */
const matches = (s) => `${s.name}\n${s.tweets.join('\n')}`.toLowerCase().includes(query);

function setSearching(on, refocus) {
  if (on === headEl.classList.contains('searching')) return;
  headEl.classList.toggle('searching', on);
  searchToggle.classList.toggle('current', on);
  if (on) {
    searchBack = document.activeElement;
    searchEl.focus();
    return;
  }
  searchEl.value = '';
  if (query) {
    query = '';
    renderList();
  }
  if (refocus && searchBack instanceof HTMLElement && searchBack.isConnected) searchBack.focus();
}

/** ⇧⌘F: puts the caret in the search field, bringing the sidebar out first if it is tucked away. */
function openSearch() {
  if (document.body.classList.contains('in-settings')) return; // the list of storms is not on screen
  if (document.body.classList.contains('collapsed')) toggleSidebar();
  setSearching(true);
  searchEl.focus();
  searchEl.select();
}

searchToggle.addEventListener('mousedown', (e) => e.preventDefault()); // the field keeps its caret, so the click below decides
searchToggle.addEventListener('click', () => setSearching(!headEl.classList.contains('searching'), true));
searchEl.addEventListener('input', () => {
  query = searchEl.value.trim().toLowerCase();
  renderList();
});
searchEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  setSearching(false, true);
});
// Left empty, the field has no reason to stay: the logo comes back.
searchEl.addEventListener('blur', () => {
  if (!query) setSearching(false, false);
});

function buildRow(s) {
  const row = el('div', 'storm' + (s === cur ? ' current' : '') + (s === menuFor ? ' menu-open' : ''));
  row.dataset.id = s.id;
  const more = el('button', 'storm-more');
  more.type = 'button';
  more.dataset.tip = 'More';
  more.setAttribute('aria-label', 'More');
  const dots = icon(DOTS_ICON, 16, 24);
  dots.classList.add('dots'); // keeps its own line weight
  dots.setAttribute('stroke-width', '3.4'); // round caps on a zero-length stroke: each speck is as wide as the stroke
  more.append(dots);
  more.popoverTargetElement = menuEl; // the button opens and closes the menu; a click on it never counts as "outside"
  more.addEventListener('mousedown', (e) => e.preventDefault()); // the caret stays where it is
  more.addEventListener('click', (e) => {
    const open = menuEl.matches(':popover-open');
    if (open && menuFor === s) return; // a second click closes it
    if (open) e.preventDefault(); // open for another storm: bring it here rather than close it
    openMenu(s, more);
  });

  // The dots share the name's line, at its right end.
  const head = el('div', 'storm-head');
  head.append(el('div', 'storm-title', titleOf(s)), more);
  row.append(head, el('div', 'storm-meta', `${plural(tweetCount(s))} · ${relTime(s.mtime)}`));
  row.addEventListener('click', (e) => {
    if (!more.contains(e.target) && renaming !== s) openStorm(s);
  });
  // A right-click anywhere on the row opens the same menu, at the pointer.
  row.addEventListener('contextmenu', (e) => {
    if (renaming === s) return; // the name being typed keeps its own
    e.preventDefault();
    const open = () => {
      openMenu(s, more, { x: e.clientX, y: e.clientY });
      if (!menuEl.matches(':popover-open')) menuEl.showPopover();
    };
    // On a Mac the menu is asked for as the button goes down. Letting the button up outside
    // an open menu closes it, so the menu waits for that to pass.
    if (e.buttons) window.addEventListener('pointerup', () => setTimeout(open), { once: true });
    else open();
  });
  return row;
}

const rowOf = (s) => [...listEl.children].find((row) => row.dataset.id === s.id);

function markMenuRow() {
  for (const row of listEl.children) row.classList.toggle('menu-open', row.dataset.id === menuFor?.id);
}

// Lucide "arrow-up-right" and "trash-2". Rename borrows the new-storm icon from the sidebar.
const NEW_TAB_ICON = 'M7 7h10v10M7 17 17 7';
const DELETE_ICON = 'M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6';

/** One line of the three-dots menu: an icon (a path, or a drawn icon to copy), a label, and
    what it does. */
function menuItem(glyph, label, run) {
  const item = el('button', 'picker-row menu-item');
  item.type = 'button';
  const svg = typeof glyph === 'string' ? icon(glyph, 14, 24) : glyph.cloneNode(true);
  svg.setAttribute('width', 14);
  svg.setAttribute('height', 14);
  svg.setAttribute('stroke-width', '1.9'); // one line weight down the menu
  item.append(svg, el('span', '', label));
  item.addEventListener('mousedown', (e) => e.preventDefault()); // the caret stays where it is
  item.addEventListener('click', () => {
    menuEl.hidePopover();
    run();
  });
  return item;
}

/** Fills the three-dots menu for a storm and puts it under that storm's button, or, for a
    right-click, at the pointer (`at`), turned upwards where there is no room below. */
function openMenu(s, anchor, at) {
  menuFor = s;
  const newTab = menuItem(NEW_TAB_ICON, 'Open in new tab', () => {
    tabs.push(s);
    show(tabs.length - 1);
  });
  newTab.disabled = tabs.includes(s); // already in a tab: there is no second one to open
  const remove = menuItem(DELETE_ICON, 'Delete', () => deleteStorm(s));
  remove.classList.add('danger');
  menuEl.replaceChildren(newTab, menuItem($('new').querySelector('svg'), 'Rename', () => startRename(s)), remove);
  const r = anchor.getBoundingClientRect();
  const height = menuEl.childElementCount * 28 + 10; // its lines and its padding
  menuEl.style.left = Math.max(8, Math.min(at ? at.x : r.left, window.innerWidth - MENU_WIDTH - 8)) + 'px';
  menuEl.style.top = (at ? (at.y + height <= window.innerHeight - 8 ? at.y : Math.max(8, at.y - height)) : r.bottom + 4) + 'px';
  markMenuRow();
}
const MENU_WIDTH = 208; // matches #row-menu in style.css

menuEl.addEventListener('toggle', () => {
  if (menuEl.matches(':popover-open')) return;
  menuFor = null;
  markMenuRow();
});

/** Turns a storm's title in the sidebar into a field for its name. Return or clicking away
    keeps what was typed, Escape leaves the name as it was, and an empty field takes the
    name off, so the storm goes by its first line again. */
function startRename(s) {
  const row = rowOf(s);
  if (!row) return;
  const back = document.activeElement;
  const before = titleOf(s);
  const input = el('input', 'storm-rename');
  input.type = 'text';
  input.value = before;
  input.maxLength = NAME_MAX;
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Storm name');
  renaming = s;
  row.classList.add('renaming');
  row.querySelector('.storm-title').replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (keep, refocus) => {
    if (done) return;
    done = true;
    renaming = null;
    const name = cleanName(input.value);
    if (keep && name !== before) setName(s, name);
    renderList();
    renderTabs();
    if (refocus && back instanceof HTMLElement && back.isConnected) back.focus();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) finish(true, true);
    else if (e.key === 'Escape') finish(false, true);
    else return;
    e.preventDefault();
  });
  input.addEventListener('blur', () => finish(true, false));
  input.addEventListener('click', (e) => e.stopPropagation());
}

/** Takes a storm out of the app and moves its file to the Trash, where it can be put back. */
async function deleteStorm(s) {
  if (s === cur) {
    // Save what was just typed first, so the copy in the Trash is the latest one.
    clearTimeout(saveTimer);
    if (dirty) {
      dirty = false;
      try {
        await write(s);
      } catch {
        // The last save stands.
      }
    }
    dirty = false;
  }
  storms = storms.filter((x) => x !== s);
  const at = tabs.indexOf(s);
  if (at >= 0) closeTab(at);
  else renderList();
  try {
    if (s.onDisk) await window.api.remove(s.id);
    s.onDisk = false;
    await window.api.trashMedia(s.id); // its images go to the Trash with it
    window.api.saveAsks(s.id, null); // and what was said about its tweets is forgotten
  } catch {
    setStatus('error');
  }
}

async function setName(s, name) {
  s.name = name;
  try {
    await write(s);
  } catch {
    setStatus('error');
  }
  drop(s); // a storm left with neither words nor a name has nothing to list
  renderList();
}

function toggleSidebar() {
  const collapsed = document.body.classList.toggle('collapsed');
  localStorage.setItem('sidebar', collapsed ? 'collapsed' : 'open');
}

// The sidebar's width is set by dragging its right edge, between a floor and a ceiling. The
// ceiling also leaves the pane room to write in, so a narrow window allows less; the width
// asked for is remembered and comes back when the window is widened again.
const SIDE_MIN = 180;
const SIDE_MAX = 420;
const PANE_MIN = 380;
let sideWidth = Number(localStorage.getItem('sidebar-width')) || 220;

function applySideWidth() {
  const ceiling = Math.max(SIDE_MIN, Math.min(SIDE_MAX, window.innerWidth - PANE_MIN));
  const width = Math.round(Math.max(SIDE_MIN, Math.min(ceiling, sideWidth)));
  document.documentElement.style.setProperty('--side-w', width + 'px');
  return width;
}

applySideWidth();
window.addEventListener('resize', applySideWidth);

const gripEl = $('side-resize');
gripEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault(); // the caret stays where it is
  const grabbed = e.clientX - applySideWidth(); // where on the edge the pointer took hold
  document.body.classList.add('resizing');
  // The drag is followed on the window, so it carries on wherever the pointer goes, and it
  // ends on release, on a move with no button held (a release that was missed), or when the
  // window loses focus.
  const move = (ev) => {
    if (ev.buttons === 0) return stop();
    sideWidth = ev.clientX - grabbed;
    sideWidth = applySideWidth(); // stop at the limits, so dragging back responds at once
  };
  const stop = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', stop, true);
    window.removeEventListener('pointercancel', stop, true);
    window.removeEventListener('blur', stop);
    document.body.classList.remove('resizing');
    localStorage.setItem('sidebar-width', String(sideWidth));
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', stop, true);
  window.addEventListener('pointercancel', stop, true);
  window.addEventListener('blur', stop);
});

// ---------- editor ----------

// ---------- undo and redo ----------
// Each storm keeps its own history while the app is open: the tweets as they stood before
// each change, with where the caret was. A run of typing counts as one change.

const HISTORY_MAX = 200;
const TYPING_PAUSE = 1000; // ms without a keystroke that ends a run of typing
/** @type {WeakMap<Storm, {undo: object[], redo: object[]}>} */
const histories = new WeakMap();
let typing = { at: 0, tweet: -1, kind: '' };
let beforeEdit = null; // the storm as it stood just before the keystroke now being handled

function historyOf(s) {
  if (!histories.has(s)) histories.set(s, { undo: [], redo: [] });
  return histories.get(s);
}

function caretNow() {
  const areas = [...tweetsEl.querySelectorAll('textarea')];
  const i = areas.indexOf(document.activeElement);
  return i < 0 ? null : { i, start: areas[i].selectionStart, end: areas[i].selectionEnd };
}

const snapshot = () => ({ tweets: cur.tweets.slice(), media: cur.media.map((m) => m.slice()), caret: caretNow() });

/** Call just before changing the open storm, so the change can be undone. */
function remember(snap = snapshot()) {
  const h = historyOf(cur);
  h.undo.push(snap);
  if (h.undo.length > HISTORY_MAX) h.undo.shift();
  h.redo.length = 0;
  typing.at = 0; // whatever comes next starts a new run
  syncHistory();
}

/** Typing is remembered a run at a time: a new run starts after a pause, in another tweet,
    when typing turns to deleting or back, and for anything pasted, cut or dropped. */
function noteTyping(i, inputType = '') {
  const kind = inputType.startsWith('delete') ? 'delete' : /^insert(Composition)?Text$/.test(inputType) ? 'type' : 'other';
  const now = Date.now();
  if (kind === 'other' || kind !== typing.kind || i !== typing.tweet || now - typing.at > TYPING_PAUSE) {
    remember(beforeEdit ?? { ...snapshot(), caret: null });
  }
  typing = { at: now, tweet: i, kind };
  beforeEdit = null;
}

/** Where the caret belongs after words in one tweet have changed: at the end of what changed.
    Null when the change was to the tweets themselves (one added, removed or moved). */
function caretAfter(before, after) {
  if (before.length !== after.length) return null;
  const changed = after.flatMap((text, i) => (text === before[i] ? [] : [i]));
  if (changed.length !== 1) return null;
  const [was, now] = [before[changed[0]], after[changed[0]]];
  // Whatever the two share at the end was not touched; the change stops just before it.
  const short = Math.min(was.length, now.length);
  let tail = 0;
  while (tail < short && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
  return { i: changed[0], start: now.length - tail, end: now.length - tail };
}

/** Undo (`back`) or redo: swaps the storm for the one remembered. Undo puts the caret back
    where it was before the change; redo puts it at the end of what came back. */
function stepHistory(back) {
  if (!cur || post.on) return; // nothing changes while posting
  const h = historyOf(cur);
  const [from, into] = back ? [h.undo, h.redo] : [h.redo, h.undo];
  const snap = from.pop();
  if (!snap) return;
  into.push(snapshot());
  const caret = (!back && caretAfter(cur.tweets, snap.tweets)) || snap.caret;
  cur.tweets = snap.tweets.slice();
  cur.media = snap.media.map((m) => m.slice());
  typing.at = 0;
  renderTweets();
  const ta = caret && tweetsEl.children[caret.i]?.querySelector('textarea');
  if (ta) {
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(caret.start, caret.end);
    ta.closest('.tweet').scrollIntoView({ block: 'nearest' });
  } else {
    focusTweet(cur.tweets.length - 1, Infinity);
  }
  touch();
}

/** The Undo and Redo buttons: off when there is nothing to step to, and out of sight on a
    storm that has never had a word in it. */
function syncHistory() {
  const h = cur ? historyOf(cur) : { undo: [], redo: [] };
  $('undo').disabled = !h.undo.length;
  $('redo').disabled = !h.redo.length;
  $('history').hidden = !cur || (!h.undo.length && !h.redo.length && isEmpty(cur));
}

for (const [id, back] of [['undo', true], ['redo', false]]) {
  $(id).addEventListener('mousedown', (e) => e.preventDefault()); // the caret stays where it is
  $(id).addEventListener('click', () => {
    hideTip();
    stepHistory(back);
  });
}

function renderTweets() {
  locate(); // what Find is looking for, in the storm as it now stands
  settleNotes();
  tweetsEl.replaceChildren(...cur.tweets.map((_, i) => buildTweet(i)));
  syncHints();
  syncFindBar();
  if (post.on && post.size !== cur.tweets.length) stopPosting(); // a tweet came or went: the ticks no longer hold
  else markPosting();
}

/** Draws a tweet's words: the part past the limit in the warning colour, and anything Find
    has matched on a tint, the match it is standing on a stronger one. */
function paintBackdrop(backdrop, text, overAt, i) {
  const mine = find.hits.filter((h) => h.tweet === i);
  const cuts = new Set([0, text.length]);
  if (overAt < text.length) cuts.add(overAt);
  for (const h of mine) cuts.add(h.start).add(h.end);
  const points = [...cuts].sort((a, b) => a - b);
  const nodes = [];
  for (let k = 0; k < points.length - 1; k++) {
    const from = points[k];
    const to = points[k + 1];
    let node = from >= overAt ? el('mark', '', text.slice(from, to)) : text.slice(from, to);
    const hit = mine.find((h) => from >= h.start && to <= h.end);
    if (hit) {
      const span = el('span', hit === find.hits[find.at] ? 'hit current' : 'hit');
      span.append(node);
      node = span;
    }
    nodes.push(node);
  }
  backdrop.replaceChildren(...nodes, '​');
}

// ---------- posting: hands the storm to X a tweet at a time ----------
// The row of buttons under the storm becomes the posting controls while this is going on,
// and writing is paused: the storm cannot be changed until posting is done or stopped.
// The first tweet opens in X's own composer; after that each press of Copy next, and only a
// press, puts the next thing on the clipboard, to paste into the thread: a tweet's words, then each of its
// images. Tweets already handed over are ticked, and the tweet (and image) on the clipboard
// now is picked out, so it is always plain which was pasted last.

/** `order` lists the tweets that have something in them, by index. `steps` is everything to be
    handed over, in turn: a tweet's words, then each of its images. `step` is the one in hand
    (-1 before the first), and `busy` is set while one is on its way to the clipboard. */
const post = { on: false, order: [], steps: [], step: -1, size: 0, busy: false };

function markPosting() {
  const now = post.on ? post.steps[post.step] ?? null : null;
  const at = now ? now.place : -1; // the place of the tweet in hand
  [...tweetsEl.children].forEach((row, i) => {
    const place = post.on ? post.order.indexOf(i) : -1;
    const done = place >= 0 && place < at;
    row.classList.toggle('posted', done);
    row.classList.toggle('posting-now', place >= 0 && place === at);
    const num = row.querySelector('.num');
    if (done && !num.firstChild) num.append(icon(CHECK_ICON, 12, 24));
    else if (!done) num.replaceChildren();
    for (const shot of row.querySelectorAll('.shot')) {
      shot.classList.toggle('now', Boolean(now) && place === now.place && shot.dataset.file === now.file);
    }
    // Writing is paused while posting: the words can be read and copied, not changed.
    const ta = row.querySelector('textarea');
    ta.readOnly = post.on;
    ta.tabIndex = post.on ? -1 : 0;
  });
  if (!post.on) return;
  const images = now ? cur.media[post.order[at]] : [];
  const nth = now?.file ? images.indexOf(now.file) + 1 : 0;
  $('post-count').textContent = `${at + 1}/${post.order.length}` + (nth ? ` · image ${nth}/${images.length}` : '');
  $('post-next-label').textContent = post.busy ? 'Copying…' : post.step >= post.steps.length - 1 ? 'Done' : 'Copy next';
}

/** Makes `step` the one in hand: every tweet before its tweet is ticked off. */
function goTo(step) {
  post.step = step;
  markPosting();
  tweetsEl.children[post.order[post.steps[step].place]]?.scrollIntoView({ block: 'nearest' });
}

/** Puts a step on the clipboard: a tweet's words, or one of its images. */
function copyStep(step) {
  const { place, file } = post.steps[step];
  return file ? window.api.copyImage(cur.id, file) : window.api.copy(outgoing(cur, post.order[place]));
}

/** A tweet copied by its own button while posting: carry on from its words. */
function takeUp(i) {
  const step = post.steps.findIndex((s) => post.order[s.place] === i && !s.file);
  if (step >= 0) goTo(step);
}

async function startPosting() {
  if (!cur || isEmpty(cur) || post.on) return;
  closeFind(false);
  post.on = true;
  post.order = cur.tweets.flatMap((_, i) => (hasContent(cur, i) ? [i] : []));
  post.steps = post.order.flatMap((i, place) => [
    ...(cur.tweets[i].trim() ? [{ place, file: null }] : []),
    ...cur.media[i].map((file) => ({ place, file })),
  ]);
  post.size = cur.tweets.length;
  post.busy = false;
  document.body.classList.add('posting');
  // The composer opens with the first tweet's words in it, so those are in hand from the
  // start. Nothing goes on the clipboard until Copy next is pressed. A first tweet that is
  // only images has no words to send, so nothing is in hand yet.
  const first = post.steps[0];
  post.step = first.file ? -1 : 0;
  markPosting();
  $('post-next').focus();
  await window.api.openComposer(first.file ? '' : outgoing(cur, post.order[0]));
}

/** Puts the following step on the clipboard, or ends once the last one has gone. Only ever
    on being asked: one press, one copy. A press that lands while a copy is still on its way
    is let go, so nothing is copied twice or skipped. */
async function copyNext() {
  if (!post.on || post.busy) return;
  if (post.step >= post.steps.length - 1) return stopPosting();
  const step = post.step + 1;
  post.busy = true;
  goTo(step); // shows at once which one is being copied
  try {
    await copyStep(step);
  } catch {
    flash("Couldn't copy that image");
  }
  post.busy = false;
  if (post.on) markPosting();
}

function stopPosting() {
  if (!post.on) return;
  post.on = false;
  post.busy = false;
  post.step = -1;
  post.steps = [];
  document.body.classList.remove('posting');
  markPosting();
  // Writing picks up again at the end of the storm, unless the caret is in some other field.
  if (cur && !(document.activeElement instanceof HTMLInputElement)) focusTweet(cur.tweets.length - 1, Infinity);
}

// While posting, Return copies the next tweet and Escape stops, wherever in the window the
// last click landed. Other fields (search, a name being typed) keep their own keys.
window.addEventListener(
  'keydown',
  (e) => {
    if (!post.on || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.target instanceof HTMLInputElement) return;
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return; // a held key is one press
    if (e.key === 'Enter') copyNext();
    else stopPosting();
  },
  true
);


// ---------- find: ⌘F looks for words in the open storm ----------

const findEl = $('find');
const findInput = $('find-input');
const findCount = $('find-count');
/** `hits` are the matches in reading order; `at` is the one Find is standing on (-1: none). */
const find = { open: false, query: '', hits: [], at: -1 };
let findBack = null; // what had the caret before, so closing can hand it back

/** Works out the matches afresh, keeping Find's place in the list where it can. */
function locate() {
  const hits = [];
  const q = find.query.toLowerCase();
  if (find.open && q && cur) {
    cur.tweets.forEach((text, tweet) => {
      // Lower-casing can change a string's length in a few scripts; then match case as typed.
      const low = text.toLowerCase();
      const [hay, needle] = low.length === text.length ? [low, q] : [text, find.query];
      for (let p = hay.indexOf(needle); p !== -1; p = hay.indexOf(needle, p + needle.length)) {
        hits.push({ tweet, start: p, end: p + needle.length });
      }
    });
  }
  find.hits = hits;
  find.at = hits.length ? Math.min(Math.max(find.at, 0), hits.length - 1) : -1;
}

function syncFindBar() {
  const n = find.hits.length;
  findCount.textContent = !find.query ? '' : n ? `${find.at + 1}/${n}` : 'No results';
  $('find-prev').disabled = $('find-next').disabled = n < 2;
}

/** Looks again and redraws every tweet. With `reveal`, brings the current match into view. */
function refreshFind(reveal) {
  if (!cur) return;
  locate();
  [...tweetsEl.children].forEach((row, i) => refreshTweet(row, i));
  syncFindBar();
  if (reveal) tweetsEl.querySelector('.hit.current')?.scrollIntoView({ block: 'center' });
}

function stepFind(by) {
  const n = find.hits.length;
  if (!n) return;
  find.at = (find.at + by + n) % n;
  refreshFind(true);
}

function openFind() {
  if (!cur) return; // nothing to look through on the settings page
  stopPosting(); // the two bars share a corner
  if (!find.open) {
    findBack = document.activeElement;
    find.open = true;
    findEl.hidden = false;
    document.body.classList.add('finding');
    find.query = findInput.value;
    find.at = 0;
    refreshFind(true);
  }
  findInput.focus();
  findInput.select();
}

/** Puts the bar away. The caret goes to the match Find was standing on, with it selected,
    or failing that back to where it was. */
function closeFind(refocus = true) {
  if (!find.open) return;
  const last = find.hits[find.at];
  find.open = false;
  findEl.hidden = true;
  document.body.classList.remove('finding');
  refreshFind(false);
  if (!refocus) return;
  const ta = last && tweetsEl.children[last.tweet]?.querySelector('textarea');
  if (ta) {
    ta.focus();
    ta.setSelectionRange(last.start, last.end);
  } else if (findBack instanceof HTMLElement && findBack.isConnected) {
    findBack.focus();
  }
}

findInput.addEventListener('input', () => {
  find.query = findInput.value;
  find.at = 0;
  refreshFind(true);
});
findInput.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Enter') stepFind(e.shiftKey ? -1 : 1);
  else if (e.key === 'Escape') closeFind();
  else return;
  e.preventDefault();
});
for (const [id, run] of [['find-prev', () => stepFind(-1)], ['find-next', () => stepFind(1)], ['find-close', () => closeFind()]]) {
  $(id).addEventListener('mousedown', (e) => e.preventDefault()); // the field keeps its caret
  $(id).addEventListener('click', run);
}

function buildTweet(i) {
  const row = el('div', 'tweet');
  const field = el('div', 'field');
  const backdrop = el('div', 'text backdrop');
  const ta = el('textarea', 'text');
  ta.rows = 1;
  ta.spellcheck = true;
  ta.placeholder = i === 0 ? 'Start typing…' : 'Keep writing…';
  ta.value = cur.tweets[i];
  field.append(backdrop, ta);

  // The tweet's number, drawn by the style sheet's counter. It is also the handle the tweet
  // is dragged by, up or down the storm.
  const num = el('div', 'num');
  num.setAttribute('aria-hidden', 'true');
  num.addEventListener('mousedown', (e) => e.preventDefault()); // the caret stays where it is
  num.addEventListener('pointerdown', (e) => {
    startSort(e, row, { axis: 'y', scroller: $('scroll'), onDrop: moveTweet });
  });

  const gutter = el('div', 'gutter');
  const copy = el('button', 'tool copy');
  copy.type = 'button';
  copy.dataset.tip = 'Copy tweet';
  copy.setAttribute('aria-label', 'Copy tweet');
  copy.append(icon(COPY_ICON, 14, 24));
  gutter.append(el('div', 'count'), el('div', 'excess'));
  // Ask: opens the question field under this tweet, or what was last said about it.
  const ask = el('button', 'tool ask');
  ask.type = 'button';
  ask.dataset.tip = 'Ask';
  ask.dataset.keys = '⌘K';
  ask.setAttribute('aria-label', 'Ask about this tweet');
  ask.append(icon(ASK_ICON, 14, 24));
  ask.addEventListener('mousedown', (e) => e.preventDefault()); // the caret stays where it is
  ask.addEventListener('click', () => {
    hideTip();
    openAsk(i);
  });
  const tools = el('div', 'tools');
  tools.append(copy, ask);
  row.append(num, field, tools, gutter, el('div', 'media'));
  renderMedia(row, i);
  const note = cur.notes?.get(i);
  ask.classList.toggle('kept', Boolean(note?.saved));
  if (note?.open) row.append(buildNote(cur, note));

  // An image pasted into a tweet is attached to it.
  ta.addEventListener('paste', (e) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    attach(i, files);
  });

  ta.addEventListener('beforeinput', () => {
    beforeEdit = snapshot();
  });
  ta.addEventListener('input', (e) => {
    noteTyping(i, e.inputType);
    const had = hasContent(cur, i);
    cur.tweets[i] = ta.value;
    if (cur.shape) cur.shape[i] = ta.value; // see settleNotes
    if (find.open) refreshFind(false); // the matches move as the words do
    else if (numbering() && had !== hasContent(cur, i)) [...tweetsEl.children].forEach(refreshTweet); // every tweet's number has changed
    else refreshTweet(row, i);
    touch();
  });
  ta.addEventListener('keydown', (e) => onKey(e, ta, i));
  copy.addEventListener('click', async () => {
    await window.api.copy(outgoing(cur, i));
    if (post.on) takeUp(i); // copied by hand: posting carries on from here
    copy.replaceChildren(icon(CHECK_ICON, 14, 24)); // a tick, for a moment, to say it worked
    setTimeout(() => copy.replaceChildren(icon(COPY_ICON, 14, 24)), 1200);
  });

  refreshTweet(row, i);
  return row;
}

function refreshTweet(row, i) {
  const text = cur.tweets[i];
  const { count, overAt } = measureOutgoing(cur, i); // its number counts too
  const over = count > LIMIT;

  paintBackdrop(row.querySelector('.backdrop'), text, over ? overAt : Infinity, i);

  row.classList.toggle('over', over);
  row.querySelector('.count').textContent = String(count);
  row.querySelector('.excess').textContent = over ? `${count - LIMIT} over` : '';
  row.querySelector('.copy').hidden = !text.trim();
}

// ---------- images on a tweet ----------
// Drop an image on a tweet, or paste one into it, and a copy is kept in the storm's folder
// and shown under the tweet's words. X takes up to four on a post.

const MEDIA_MAX = 4;
const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
/** Images already read from disk, as page URLs, by `storm/file`. */
const mediaUrls = new Map();

function mediaUrl(id, file) {
  const key = `${id}/${file}`;
  if (!mediaUrls.has(key)) {
    mediaUrls.set(
      key,
      window.api.readMedia(id, file).then(({ mime, bytes }) => URL.createObjectURL(new Blob([bytes], { type: mime })))
    );
  }
  return mediaUrls.get(key);
}

function renderMedia(row, i) {
  const storm = cur;
  row.querySelector('.media').replaceChildren(
    ...storm.media[i].map((file, k) => {
      const shot = el('div', 'shot');
      shot.dataset.file = file;
      const img = el('img');
      img.alt = '';
      img.draggable = false;
      mediaUrl(storm.id, file).then(
        (url) => (img.src = url),
        () => shot.classList.add('missing') // the file has gone from the folder
      );
      const remove = el('button', 'shot-remove');
      remove.type = 'button';
      remove.dataset.tip = 'Remove image';
      remove.setAttribute('aria-label', 'Remove image');
      remove.append(icon('M18 6L6 18M6 6l12 12', 12, 24));
      remove.addEventListener('mousedown', (e) => e.preventDefault()); // the caret stays where it is
      remove.addEventListener('click', () => {
        hideTip();
        remember();
        cur.media[i].splice(k, 1);
        renderMedia(row, i);
        touch();
      });
      shot.append(img, remove);
      // With more than one image, each can be dragged along the row into a new order.
      shot.addEventListener('mousedown', (e) => e.preventDefault()); // the caret stays where it is
      shot.addEventListener('pointerdown', (e) => {
        if (post.on || remove.contains(e.target)) return;
        startSort(e, shot, {
          axis: 'x',
          scroller: shot.parentElement,
          onDrop: (from, to) => {
            remember();
            cur.media[i].splice(to, 0, ...cur.media[i].splice(from, 1));
            renderMedia(row, i);
            touch();
          },
        });
      });
      return shot;
    })
  );
}

/** Attaches image files to tweet i, as many as it still has room for. */
async function attach(i, files) {
  if (!cur || post.on) return;
  const storm = cur;
  const images = [...files].filter((f) => IMAGE_EXT[f.type]);
  if (!images.length) return flash('Only images can be added');
  const room = MEDIA_MAX - storm.media[i].length;
  if (room <= 0) return flash(`A tweet takes up to ${MEDIA_MAX} images`);
  const names = [];
  try {
    for (const f of images.slice(0, room)) {
      names.push(await window.api.addMedia(storm.id, IMAGE_EXT[f.type], new Uint8Array(await f.arrayBuffer())));
    }
  } catch {
    return flash("Couldn't add that image");
  }
  if (storm !== cur || !storm.media[i]) return; // the storm was put away, or the tweet went, while the files were copied
  remember();
  storm.media[i].push(...names);
  renderMedia(tweetsEl.children[i], i);
  touch();
  if (images.length > room) flash(`A tweet takes up to ${MEDIA_MAX} images`);
}

// A file dropped anywhere in the window must never replace the app with itself.
const carriesFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (e) => {
    if (carriesFiles(e)) e.preventDefault();
  });
}

// The tweet under a dragged image is picked out, and takes it when it is let go.
let dropRow = null;
function setDropRow(row) {
  if (row === dropRow) return;
  dropRow?.classList.remove('drop');
  dropRow = row;
  row?.classList.add('drop');
}
tweetsEl.addEventListener('dragover', (e) => {
  if (!carriesFiles(e) || post.on) return;
  const row = e.target.closest('.tweet');
  setDropRow(row);
  if (row) e.dataTransfer.dropEffect = 'copy';
});
tweetsEl.addEventListener('dragleave', (e) => {
  if (!tweetsEl.contains(e.relatedTarget)) setDropRow(null);
});
tweetsEl.addEventListener('drop', (e) => {
  const row = dropRow;
  setDropRow(null);
  if (!row || !carriesFiles(e)) return;
  e.preventDefault();
  attach([...tweetsEl.children].indexOf(row), e.dataTransfer.files);
});

/** Takes a tweet out of the storm and leaves the caret at the end of the one before it. */
function deleteTweet(i) {
  if (cur.tweets.length < 2) return;
  remember();
  cur.tweets.splice(i, 1);
  cur.media.splice(i, 1);
  renderTweets();
  focusTweet(Math.max(0, i - 1), Infinity);
  touch();
}

/** Moves a tweet to a new place in the storm, keeping the caret in the tweet it was in. */
function moveTweet(from, to) {
  const areas = [...tweetsEl.querySelectorAll('textarea')];
  const held = areas.indexOf(document.activeElement);
  const selection = held >= 0 ? [areas[held].selectionStart, areas[held].selectionEnd] : null;
  remember();
  stopPosting(); // the order has changed under it
  cur.tweets.splice(to, 0, ...cur.tweets.splice(from, 1));
  cur.media.splice(to, 0, ...cur.media.splice(from, 1));
  if (cur.notes?.size) {
    cur.notes = new Map([...cur.notes].map(([at, note]) => [movedIndex(at, from, to), note]));
    keepNotes(cur);
  }
  cur.shape = cur.tweets.slice(); // the replies have been moved by hand: nothing for settleNotes to work out
  renderTweets();
  if (selection) {
    const ta = tweetsEl.children[movedIndex(held, from, to)].querySelector('textarea');
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(...selection);
  }
  touch();
}

function focusTweet(i, pos) {
  const ta = tweetsEl.children[i]?.querySelector('textarea');
  if (!ta) return;
  const at = Math.min(pos, ta.value.length);
  ta.focus();
  ta.setSelectionRange(at, at);
  ta.closest('.tweet').scrollIntoView({ block: 'nearest' });
}

/** Which visual line the caret is on, so arrow keys can cross between tweets. */
function caretLine(ta) {
  const pos = ta.selectionStart;
  const marker = el('span', '', '​');
  measureEl.style.width = ta.clientWidth + 'px';
  measureEl.replaceChildren(ta.value.slice(0, pos), marker, ta.value.slice(pos), '​');
  const top = marker.offsetTop;
  return {
    first: top < LINE_HEIGHT / 2,
    last: top > measureEl.offsetHeight - LINE_HEIGHT * 1.5,
  };
}

function splitTweet(ta, i) {
  remember();
  const text = ta.value;
  cur.tweets.splice(i, 1, text.slice(0, ta.selectionStart).trimEnd(), text.slice(ta.selectionEnd).trimStart());
  cur.media.splice(i + 1, 0, []); // the images stay with the first half
  renderTweets();
  focusTweet(i + 1, 0);
  unfold(tweetsEl.children[i + 1]);
  tweetsEl.children[i].classList.add('draw-rail'); // the rail down to the new tweet draws in
  touch();
}

/** Lets a new tweet open up gently: its space grows first, easing what is below it down the
    page, and the tweet itself fades in as the space settles. */
function unfold(row) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const style = getComputedStyle(row);
  const full = { height: row.offsetHeight + 'px', paddingTop: style.paddingTop, paddingBottom: style.paddingBottom };
  row.style.overflow = 'hidden';
  const motion = row.animate(
    [
      { height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0 },
      { opacity: 0, offset: 0.3 },
      { ...full, opacity: 1 },
    ],
    { duration: 680, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }
  );
  motion.onfinish = motion.oncancel = () => {
    row.style.overflow = '';
    row.scrollIntoView({ block: 'nearest' });
  };
}

function mergeUp(i) {
  remember();
  const a = cur.tweets[i - 1];
  const b = cur.tweets[i];
  const joiner = a && b && !/\s$/.test(a) && !/^\s/.test(b) ? ' ' : '';
  cur.tweets.splice(i - 1, 2, a + joiner + b);
  cur.media.splice(i - 1, 2, [...cur.media[i - 1], ...cur.media[i]]);
  renderTweets();
  focusTweet(i - 1, a.length);
  touch();
}

function onKey(e, ta, i) {
  if (e.isComposing) return;
  const collapsed = ta.selectionStart === ta.selectionEnd;
  const plain = !e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey;
  const last = cur.tweets.length - 1;

  if (e.key === 'Escape' && find.open) {
    e.preventDefault();
    closeFind();
  } else if (e.key === 'Enter' && e.metaKey && !e.shiftKey) {
    e.preventDefault();
    if (!isEmpty(cur)) splitTweet(ta, i); // like its button, it waits for the first words
  } else if (e.key === 'Backspace' && e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && last > 0) {
    // ⇧⌘⌫ deletes the tweet the caret is in. The only tweet is the storm itself, so it stays.
    e.preventDefault();
    deleteTweet(i);
  } else if (e.key === 'Backspace' && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && i > 0) {
    // Like its button, it joins this tweet to the one above wherever the caret is. In the first
    // tweet there is nothing above, so the key keeps its usual job of deleting to the line's start.
    e.preventDefault();
    mergeUp(i);
  } else if (e.key === 'ArrowUp' && plain && collapsed && i > 0 && caretLine(ta).first) {
    e.preventDefault();
    focusTweet(i - 1, Infinity);
  } else if (e.key === 'ArrowDown' && plain && collapsed && i < last && caretLine(ta).last) {
    e.preventDefault();
    focusTweet(i + 1, 0);
  } else if (e.key === 'ArrowLeft' && plain && collapsed && i > 0 && ta.selectionStart === 0) {
    e.preventDefault();
    focusTweet(i - 1, Infinity);
  } else if (e.key === 'ArrowRight' && plain && collapsed && i < last && ta.selectionStart === ta.value.length) {
    e.preventDefault();
    focusTweet(i + 1, 0);
  }
}

// The buttons under the storm do what their shortcuts do, on the tweet the caret is in
// (or the last tweet, if the caret is elsewhere).
const hintsEl = $('hints');

function targetTweet() {
  const areas = [...tweetsEl.querySelectorAll('textarea')];
  const at = areas.indexOf(document.activeElement);
  return at >= 0 ? { ta: areas[at], i: at, focused: true } : { ta: areas[areas.length - 1], i: areas.length - 1, focused: false };
}

/** A storm with nothing written is at rest: its buttons are off and its count is hidden.
    The first character wakes them. After that, only Merge up goes off, on the first tweet. */
function syncHints() {
  const blank = !cur || isEmpty(cur);
  $('editor').classList.toggle('blank', blank);
  for (const pill of hintsEl.querySelectorAll('.pill')) {
    pill.classList.toggle('off', blank || (pill.dataset.act === 'merge-up' && targetTweet().i <= 0));
  }
}

hintsEl.addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret where it is
hintsEl.addEventListener('click', (e) => {
  const button = e.target.closest('.pill');
  if (!button || button.classList.contains('off') || !cur) return;
  const { ta, i, focused } = targetTweet();
  if (button.dataset.act === 'post') return startPosting();
  if (button.dataset.act === 'post-next') return copyNext();
  if (button.dataset.act === 'post-stop') return stopPosting();
  if (button.dataset.act === 'merge-up') return mergeUp(i);
  if (!focused) focusTweet(i, Infinity);
  splitTweet(ta, i);
});
tweetsEl.addEventListener('focusin', syncHints);

// Clicking the empty page below the storm puts the caret at its end.
$('scroll').addEventListener('mousedown', (e) => {
  if (e.target.closest('.tweet') || e.target.closest('#hints') || !cur) return;
  e.preventDefault();
  if (post.on) return; // writing is paused while posting
  focusTweet(cur.tweets.length - 1, Infinity);
});

// ---------- asking: a second opinion on a tweet ----------
// Each tweet has an Ask button beside Copy; ⌘K is the same button on the tweet the caret is
// in. It opens a few ready questions and a field under the tweet. The question goes to the
// connected model with the whole storm for context, and the reply sits under the tweet to be
// read. It never changes a word of the storm: the writer takes what they like from it by hand.
//
// The last reply about a tweet is kept with it (in the app's own data, not the storm's file),
// so opening Ask on that tweet again shows it without asking anything. Reset forgets it and
// brings the questions back.

/** The ready questions as they come: what the button says, and what the model is asked. */
const OWN_ASKS = [
  { label: 'What do you think?', ask: 'What do you think?' },
  { label: 'Critique it', ask: 'Critique it. What is weak, unclear or unconvincing here?' },
  { label: 'Tighten it', ask: 'How could this say the same in fewer words?' },
  { label: 'Check the flow', ask: 'Does this follow from the tweet before it, and lead into the one after?' },
];

/** The ready questions as they now stand: Settings can add to them and take any away. */
function readyAsks() {
  try {
    const kept = JSON.parse(localStorage.getItem('prompts'));
    if (Array.isArray(kept)) return kept.filter((a) => typeof a?.label === 'string' && a.label && typeof a.ask === 'string' && a.ask);
  } catch {
    // Not a list: the ones that came with the app.
  }
  return OWN_ASKS;
}
const sameAsks = (a, b) => a.length === b.length && a.every((x, k) => x.label === b[k].label && x.ask === b[k].ask);
function saveAsks(asks) {
  if (sameAsks(asks, OWN_ASKS)) localStorage.removeItem('prompts');
  else localStorage.setItem('prompts', JSON.stringify(asks));
}

const ASK_KEPT = 5; // how many typed questions are offered again
const ASK_ICON = document.querySelector('section[data-section="ai"]').dataset.icon; // the Intelligence page's own mark
const RESET_ICON = 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5';
const CLOSE_ICON = 'M4 4l8 8M12 4l-8 8';

const askSystem = () => [
  'You are a second pair of eyes for someone writing a tweet storm (a thread for X) in a writing app.',
  'They ask about one tweet at a time. They will read what you say and then edit the tweet themselves, taking what they like, so give your opinion rather than a finished rewrite.',
  'Be direct and specific. Quote the exact words you mean, in double quotes. Say what works as well as what does not, and do not flatter.',
  'Keep it short: three short paragraphs at most and under 90 words, unless the question needs more.',
  'Write plain text: no markdown, no headings, no lists, no emoji.',
  `If you offer another wording, put it on a line of its own that starts with "> ", and offer two at most. A tweet holds ${LIMIT.toLocaleString('en-US')} characters.`,
  'The rest of the storm is there for context. Comment on the other tweets only if the question is about them, and call one "tweet 6", not "[6]".',
].join('\n');

/** What the model is sent: the storm as numbered tweets, which one is meant, and the question. */
function askRequest(s, i, question) {
  const tweets = s.tweets.map((text, k) => {
    const images = s.media[k].length ? `\n(${s.media[k].length === 1 ? 'an image is' : `${s.media[k].length} images are`} attached)` : '';
    return `[${k + 1}]\n${text.trim() || '(nothing written yet)'}${images}`;
  });
  const named = s.name ? `The storm is called "${s.name}". Its tweets:` : 'The storm, tweet by tweet:';
  const about = `The question is about tweet [${i + 1}] (${measure(s.tweets[i]).count} of ${LIMIT} characters).`;
  return { system: askSystem(), prompt: `${named}\n\n${tweets.join('\n\n')}\n\n${about}\n\nQuestion: ${question}` };
}

/** The questions typed before, newest first. */
function pastAsks() {
  try {
    const kept = JSON.parse(localStorage.getItem('asks'));
    return Array.isArray(kept) ? kept.filter((q) => typeof q === 'string' && q && !readyAsks().some((a) => a.label === q)).slice(0, ASK_KEPT) : [];
  } catch {
    return [];
  }
}

function keepAsk(question) {
  if (readyAsks().some((a) => a.label === question)) return;
  localStorage.setItem('asks', JSON.stringify([question, ...pastAsks().filter((q) => q !== question)].slice(0, ASK_KEPT)));
}

// A tweet's note is `{ saved, open, phase, … }`: `saved` is the last reply about it
// (`{ question, reply, model }`), which outlives the note being closed and the app being quit;
// `phase` is what an open note shows: 'asking', 'waiting', 'done', 'failed' or 'unconnected'.

/** Gives each storm the replies kept from earlier: `{ storm id: { tweet number: saved } }`. */
function loadNotes(kept) {
  for (const s of storms) {
    const mine = Object.entries(kept?.[s.id] ?? {}).filter(([at, r]) => Number(at) < s.tweets.length && typeof r?.reply === 'string' && r.reply);
    if (mine.length) s.notes = new Map(mine.map(([at, r]) => [Number(at), { saved: { question: String(r.question || ''), reply: r.reply, model: String(r.model || '') }, open: false, phase: 'done' }]));
  }
}

/** Writes down a storm's kept replies, by tweet number. */
function keepNotes(s) {
  const kept = [...(s.notes ?? [])].filter(([, note]) => note.saved).map(([at, note]) => [at, note.saved]);
  window.api.saveAsks(s.id, kept.length ? Object.fromEntries(kept) : null);
}

/** Notes are held by tweet number. When tweets come and go (a split, a merge, a deletion, an
    undo), each note is moved to where its tweet now stands: the storm is compared with how it
    stood at the last redraw, and whatever lies past the change shifts with it. A note whose
    tweet is gone goes with it. */
function settleNotes() {
  const was = cur.shape;
  const now = cur.tweets;
  cur.shape = now.slice();
  if (!cur.notes?.size || !was) return;
  let head = 0;
  while (head < was.length && head < now.length && was[head] === now[head]) head++;
  let tail = 0;
  while (tail < was.length - head && tail < now.length - head && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
  const changed = now.length - head - tail; // how many tweets now stand where the changed ones stood
  const settled = new Map();
  let moved = false;
  for (const [at, note] of cur.notes) {
    const to = at < head ? at : at >= was.length - tail ? at + now.length - was.length : changed ? head + Math.min(at - head, changed - 1) : -1;
    if (to !== at) moved = true;
    if (to >= 0 && !settled.has(to)) settled.set(to, note);
    else if (note.key) window.api.cancelAsk(note.key);
  }
  cur.notes = settled;
  if (moved) keepNotes(cur);
}

const noteAt = (s, note) => [...(s.notes ?? [])].find(([, n]) => n === note)?.[0] ?? -1;

/** Redraws tweet `i`'s note, and its Ask button, which stays in view while a reply is kept.
    `fresh` lets the note fade in: it is new, or has changed what it is. A note with nothing
    kept and nothing showing is let go. */
function paintNote(s, i, fresh = false) {
  const note = s.notes?.get(i);
  if (note && !note.open && !note.saved) s.notes.delete(i);
  const row = s === cur && tweetsEl.children[i];
  if (!row) return null;
  row.querySelector(':scope > .note')?.remove();
  row.querySelector('.ask').classList.toggle('kept', Boolean(note?.saved));
  if (!note?.open) return null;
  const box = buildNote(s, note);
  if (fresh) box.classList.add('fresh');
  row.append(box);
  box.scrollIntoView({ block: 'nearest' });
  return box;
}

/** The caret goes back into the note's tweet, where it was when Ask was opened. */
function backToTweet(s, note, i = noteAt(s, note)) {
  const ta = s === cur && tweetsEl.children[i]?.querySelector('textarea');
  if (!ta) return;
  ta.focus({ preventScroll: true });
  if (note.caret) ta.setSelectionRange(...note.caret.map((at) => Math.min(at, ta.value.length)));
}

/** A tweet's Ask button, or ⌘K for the tweet the caret is in (or whose question field it is
    in). It opens the tweet's note and, pressed again, closes it. A tweet with a reply kept
    opens on that reply and nothing is asked: asking again is what Reset is for. Any other
    tweet opens on the questions. */
async function openAsk(at) {
  if (!cur || post.on || isEmpty(cur)) return;
  const s = cur;
  const asking = document.activeElement?.classList.contains('ask-input') ? document.activeElement.closest('.tweet') : null;
  const i = Number.isInteger(at) ? at : asking ? [...tweetsEl.children].indexOf(asking) : targetTweet().i;
  const ta = tweetsEl.children[i]?.querySelector('textarea');
  if (!ta) return;
  s.notes ??= new Map();
  const note = s.notes.get(i) ?? { saved: null, open: false, phase: 'asking' };
  if (note.open) {
    if (note.phase !== 'waiting') closeNote(s, note, Boolean(tweetsEl.children[i].querySelector('.note')?.contains(document.activeElement)));
    return;
  }
  s.notes.set(i, note);
  note.caret = document.activeElement === ta ? [ta.selectionStart, ta.selectionEnd] : null;
  if (note.saved) {
    Object.assign(note, { open: true, phase: 'done' });
    paintNote(s, i, true);
    return;
  }
  Object.assign(note, { open: true, phase: 'asking', typed: '', picked: -1 });
  paintNote(s, i, true)?.querySelector('.ask-input').focus();
  // Asking needs a connection. The field is up at once; if it turns out there is none, it says so.
  const view = await window.api.aiList();
  if (view.model || !note.open || note.phase !== 'asking' || noteAt(s, note) < 0) return;
  note.phase = 'unconnected';
  paintNote(s, noteAt(s, note), true);
  backToTweet(s, note);
}

/** Closes a note, calling off a question that is still out. What is kept stays kept. */
function closeNote(s, note, refocus = false) {
  const i = noteAt(s, note);
  if (i < 0) return;
  if (note.key) window.api.cancelAsk(note.key);
  note.key = null;
  Object.assign(note, { open: false, phase: note.saved ? 'done' : 'asking' });
  paintNote(s, i, true);
  if (refocus) backToTweet(s, note, i);
}

/** Reset: forgets the reply kept for this tweet and opens the questions again. */
function resetNote(s, note) {
  const i = noteAt(s, note);
  if (i < 0) return;
  Object.assign(note, { saved: null, phase: 'asking', typed: '', picked: -1 });
  keepNotes(s);
  paintNote(s, i, true)?.querySelector('.ask-input').focus();
}

/** Sends a question: `label` is how it is shown, `ask` what the model is asked. The caret
    goes back to the tweet, so writing carries on while it is away. The reply, when it comes,
    is kept for the tweet in place of the one before. */
async function sendAsk(s, note, label, ask = label) {
  const key = `ask-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  Object.assign(note, { phase: 'waiting', question: label, ask, key, error: '', partial: '' });
  keepAsk(label);
  paintNote(s, noteAt(s, note), true);
  backToTweet(s, note);
  asksOut.set(key, { s, note });
  const done = await window.api.ask(key, askRequest(s, noteAt(s, note), ask)).finally(() => asksOut.delete(key));
  if (done.cancelled || note.key !== key || noteAt(s, note) < 0) return; // called off, or its tweet is gone
  const shown = Boolean(note.partial); // its words are on the page already: they are not brought in again
  Object.assign(note, { key: null, partial: '' });
  if (done.ok) {
    Object.assign(note, { phase: 'done', saved: { question: label, reply: done.text, model: done.model || '' } });
    keepNotes(s);
  } else {
    Object.assign(note, { phase: 'failed', error: done.error });
  }
  paintNote(s, noteAt(s, note), !shown || !done.ok);
}

// A reply's words as they arrive. They take the place of the waiting line in the note, which
// then grows with them; the note is kept in view only if its foot was in view before.
const asksOut = new Map(); // the questions that are out: request key → { s, note }
window.api.onAskText((key, text) => {
  const asked = asksOut.get(key);
  if (!asked || asked.note.key !== key || asked.note.phase !== 'waiting') return;
  const { s, note } = asked;
  note.partial = text;
  const box = s === cur && note.open && tweetsEl.children[noteAt(s, note)]?.querySelector(':scope > .note');
  if (!box) return;
  const inView = box.getBoundingClientRect().bottom <= $('scroll').getBoundingClientRect().bottom + 1;
  let reply = box.querySelector('.note-reply');
  if (!reply) {
    reply = el('div', 'note-reply');
    box.querySelector('.note-line')?.replaceWith(reply);
  }
  reply.replaceChildren(...replyBlocks(text));
  if (inView) box.scrollIntoView({ block: 'nearest' });
});

/** The reply as it is read: paragraphs, and any wording the model offered ("> …") set apart in
    a block of its own with a button to copy it. Words in double quotes are the model pointing
    at the writer's own, so they are drawn brighter. Stray markdown is taken as plain words. */
function replyBlocks(text) {
  const blocks = [];
  const lines = text
    .replace(/\*\*|__|`/g, '')
    .split('\n')
    .map((line) => line.trim().replace(/^#+\s+/, '').replace(/^[-*]\s+/, '• '));
  let open = null; // the paragraph or offered wording being gathered
  for (const line of lines) {
    const offered = line.startsWith('>');
    const words = offered ? line.replace(/^>\s*/, '') : line;
    if (!words) open = null;
    else if (open && open.offered === offered) open.lines.push(words);
    else blocks.push((open = { offered, lines: [words] }));
  }
  return blocks.map(({ offered, lines }) => {
    if (!offered) {
      const p = el('p');
      p.append(...lines.join('\n').split(/([“"][^“”"\n]{2,}[”"])/).map((part, k) => (k % 2 ? el('em', '', part) : part)));
      return p;
    }
    const wording = lines.join('\n').replace(/^[“"]([^“”"]*)[”"]$/, '$1');
    const block = el('div', 'offered');
    const copy = el('button', 'note-btn');
    copy.type = 'button';
    copy.dataset.tip = 'Copy';
    copy.setAttribute('aria-label', 'Copy this wording');
    copy.append(icon(COPY_ICON, 14, 24));
    copy.addEventListener('click', async () => {
      await window.api.copy(wording);
      copy.replaceChildren(icon(CHECK_ICON, 14, 24));
      setTimeout(() => copy.replaceChildren(icon(COPY_ICON, 14, 24)), 1200);
    });
    block.append(el('div', '', wording), copy);
    return block;
  });
}

/** A small button in a note: an icon, what it is called, what it does. */
function noteButton(glyph, box, name, run) {
  const button = el('button', 'note-btn');
  button.type = 'button';
  button.setAttribute('aria-label', name);
  button.dataset.tip = name;
  button.append(icon(glyph, 14, box));
  button.addEventListener('mousedown', (e) => e.preventDefault()); // the caret stays in the tweet
  button.addEventListener('click', () => {
    hideTip();
    run();
  });
  return button;
}

/** Draws a note as it now stands: the questions, the wait, the reply, or what went wrong. */
function buildNote(s, note) {
  const box = el('div', 'note is-' + note.phase);
  if (note.phase === 'asking') return buildAsk(s, note, box);
  const close = noteButton(CLOSE_ICON, 16, note.phase === 'waiting' ? 'Cancel' : 'Close', () => closeNote(s, note));

  if (note.phase === 'unconnected') {
    const connect = el('button', 'btn', 'Connect…');
    connect.type = 'button';
    connect.addEventListener('click', () => {
      closeNote(s, note);
      sectionId = 'ai';
      localStorage.setItem('settings-section', sectionId);
      openSettings();
    });
    const acts = el('div', 'note-acts');
    acts.append(close);
    const line = el('div', 'note-line');
    line.append(el('span', '', 'Asking needs Claude or ChatGPT connected.'), connect, acts);
    box.append(line);
    return box;
  }

  // The top line: what was asked, which model answered, and the buttons.
  const done = note.phase === 'done';
  const acts = el('div', 'note-acts');
  if (done) acts.append(noteButton(RESET_ICON, 24, 'Reset', () => resetNote(s, note)));
  acts.append(close);
  const head = el('div', 'note-head');
  head.append(el('span', 'note-ask', done ? note.saved.question : note.question), el('span', 'note-model', done ? note.saved.model.toLowerCase() : ''), acts);
  box.append(head);
  if (note.phase === 'waiting' && note.partial) {
    const reply = el('div', 'note-reply');
    reply.append(...replyBlocks(note.partial));
    box.append(reply);
  } else if (note.phase === 'waiting') {
    const line = el('div', 'note-line');
    line.append(aiWaiting(), el('span', '', 'Waiting for a reply…'));
    box.append(line);
  } else if (note.phase === 'failed') {
    const again = el('button', 'btn', 'Try again');
    again.type = 'button';
    again.addEventListener('click', () => sendAsk(s, note, note.question, note.ask));
    const line = el('div', 'note-line');
    line.append(el('span', 'error', note.error || 'No reply came back.'), again);
    box.append(line);
  } else {
    const reply = el('div', 'note-reply');
    reply.append(...replyBlocks(note.saved.reply));
    box.append(reply);
  }
  return box;
}

/** The questions: the ready ones as buttons, a field for any other, and under it the ones
    typed before. Return sends what is typed, or the earlier question the arrows have picked;
    with neither, it does nothing. */
function buildAsk(s, note, box) {
  const ready = el('div', 'ask-ready');
  ready.append(
    ...readyAsks().map((a) => {
      const button = el('button', 'ask-chip', a.label);
      button.type = 'button';
      button.addEventListener('click', () => sendAsk(s, note, a.label, a.ask));
      return button;
    })
  );
  const field = el('label', 'ask-field');
  const input = el('input', 'ask-input');
  input.type = 'text';
  input.spellcheck = false;
  input.placeholder = 'Ask about this tweet';
  input.setAttribute('aria-label', 'Ask about this tweet');
  input.value = note.typed || '';
  field.append(input, el('span', 'keys', '↵'));
  const list = el('div', 'ask-list');
  // The ready questions share their row with the way out.
  const acts = el('div', 'note-acts');
  acts.append(noteButton(CLOSE_ICON, 16, 'Close', () => closeNote(s, note, true)));
  // With every ready question removed in Settings, the field takes their place in the row.
  const top = el('div', 'ask-top');
  if (ready.childElementCount) {
    top.append(ready, acts);
    box.append(top, field, list);
  } else {
    top.classList.add('bare');
    top.append(field, acts);
    box.append(top, list);
  }

  let shown = [];
  const draw = () => {
    const typed = input.value.trim().toLowerCase();
    shown = pastAsks().filter((q) => !typed || (q.toLowerCase().includes(typed) && q.toLowerCase() !== typed));
    note.picked = Math.max(-1, Math.min(note.picked ?? -1, shown.length - 1));
    list.replaceChildren(
      ...shown.map((q, k) => {
        const item = el('button', 'ask-item' + (k === note.picked ? ' picked' : ''), q);
        item.type = 'button';
        item.tabIndex = -1;
        item.addEventListener('click', () => sendAsk(s, note, q));
        return item;
      })
    );
    list.hidden = !shown.length;
  };
  draw();

  // A click on a button or an earlier question leaves the field its caret.
  ready.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('mousedown', (e) => e.preventDefault());
  input.addEventListener('input', () => {
    note.typed = input.value;
    note.picked = -1; // typed words are the question until the arrows say otherwise
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeNote(s, note, true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const typed = input.value.trim();
      if (note.picked >= 0) sendAsk(s, note, shown[note.picked]);
      else if (typed) sendAsk(s, note, typed);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      note.picked = Math.max(-1, Math.min(note.picked + (e.key === 'ArrowDown' ? 1 : -1), shown.length - 1));
      draw();
    }
  });
  // Going back to the storm puts unasked questions away. Leaving the window does not.
  box.addEventListener('focusout', (e) => {
    if (note.open && note.phase === 'asking' && e.relatedTarget && !box.contains(e.relatedTarget)) closeNote(s, note);
  });
  return box;
}

// ---------- wallpaper ----------
// The wallpaper is the backdrop of a storm that hasn't been started. The first character
// written sends it away; emptying the storm brings it back.

const paneWall = Wallpaper.surface($('wall-dither'));
const previewWall = Wallpaper.surface($('wallpaper-preview-dither'));

// The image can be drawn dithered, blurred or grainy; the choice is kept like the theme is.
const EFFECTS = [
  ['dither', 'Dither'],
  ['blur', 'Blur'],
  ['grain', 'Grain'],
];
function currentEffect() {
  const saved = localStorage.getItem('wallpaper-effect');
  return EFFECTS.some(([id]) => id === saved) ? saved : 'dither';
}
Wallpaper.setEffect(currentEffect());

function renderEffects() {
  // Nothing to draw without an image, so nothing to choose.
  segmented('wallpaper-effects', EFFECTS.map(([id, name]) => [id, name, !hasWallpaper]), currentEffect(), (id) => {
    localStorage.setItem('wallpaper-effect', id);
    Wallpaper.setEffect(id);
    renderEffects();
  });
}

function updateWall() {
  const on = hasWallpaper && !!cur && isEmpty(cur);
  document.body.classList.toggle('wall', on);
  paneWall.setActive(on);
  // The preview in Settings draws only while Settings is the tab on screen.
  $('wallpaper-preview').hidden = !hasWallpaper;
  previewWall.setActive(hasWallpaper && !cur);
}

async function applyWallpaper(w) {
  const label = $('wallpaper-current');
  label.classList.remove('error');
  label.textContent = '';
  try {
    await Wallpaper.load(w.kind === 'none' ? null : w.bytes, w.mime);
    hasWallpaper = w.kind !== 'none';
  } catch {
    await Wallpaper.load(null);
    hasWallpaper = false;
    label.classList.add('error');
    label.textContent = "Couldn't read that image. Try a JPEG or PNG.";
  }
  $('wallpaper-none').disabled = !hasWallpaper; // nothing to remove without an image
  renderEffects();
  updateWall();
}

// ---------- settings ----------

/** A thumbnail of the app in a palette: frame, pane, two lines of text, an accent dot. */
function previewOf(palette) {
  const preview = el('span', 'theme-preview');
  preview.style.setProperty('--p-frame', palette.frame);
  preview.style.setProperty('--p-bg', palette.bg);
  preview.style.setProperty('--p-text', palette.text);
  preview.style.setProperty('--p-accent', palette.accent);
  const pane = el('span', 'theme-pane');
  pane.append(el('span', 'theme-line'), el('span', 'theme-line'), el('span', 'theme-dot'));
  preview.append(pane);
  return preview;
}

/** System, Light, Dark: each drawn in the current theme, System as half of each. */
function renderModes() {
  const theme = currentThemeId();
  const current = currentMode();
  $('modes').replaceChildren(
    ...MODES.map((mode) => {
      const card = el('button', 'mode' + (mode === current ? ' current' : ''));
      card.type = 'button';
      card.dataset.tip = mode[0].toUpperCase() + mode.slice(1);
      card.setAttribute('aria-label', card.dataset.tip + ' mode');
      if (mode === 'system') {
        const split = el('span', 'mode-split');
        const dark = previewOf(paletteOf(theme, 'dark'));
        dark.classList.add('half');
        split.append(previewOf(paletteOf(theme, 'light')), dark);
        card.append(split);
      } else {
        card.append(previewOf(paletteOf(theme, mode)));
      }
      card.addEventListener('click', () => {
        setMode(mode);
        renderAppearance();
      });
      return card;
    })
  );
}

function renderThemes() {
  const current = currentThemeId();
  $('themes').replaceChildren(
    ...THEMES.map((t) => {
      const card = el('button', 'theme' + (t.id === current ? ' current' : ''));
      card.type = 'button';
      card.append(previewOf(paletteOf(t.id)), el('span', 'theme-name', t.name));
      card.addEventListener('click', () => {
        applyTheme(t.id);
        renderAppearance();
      });
      return card;
    })
  );
}

function renderAppearance() {
  renderModes();
  renderThemes();
}

// The Mac switched between light and dark while the mode is System.
document.addEventListener('appearancechange', renderAppearance);

// Each <section> in the settings page is one page of settings and one entry in the sidebar,
// named by its data-name and drawn with the icon in its data-icon.
const sectionEls = [...document.querySelectorAll('#settings-page section')];
let sectionId = localStorage.getItem('settings-section');

function renderSettings() {
  if (!sectionEls.some((s) => s.dataset.section === sectionId)) sectionId = sectionEls[0].dataset.section;
  $('settings-nav').replaceChildren(
    ...sectionEls.map((s) => {
      const item = el('button', 'side-item' + (s.dataset.section === sectionId ? ' current' : ''));
      item.type = 'button';
      item.append(icon(s.dataset.icon, 16, 24), el('span', '', s.dataset.name));
      item.addEventListener('click', () => {
        sectionId = s.dataset.section;
        localStorage.setItem('settings-section', sectionId);
        renderSettings();
      });
      return item;
    })
  );
  for (const s of sectionEls) s.hidden = s.dataset.section !== sectionId;
  renderGeneral();
  renderAppearance();
  renderAI();
  renderPrompts();
  renderKept();
  if (sectionId === 'ai') refreshAI();
}

// ---------- settings: General ----------

/** Draws a segmented control: `options` are [value, label, off] (`off`: out of reach),
    `current` the one chosen, and `choose(value)` what pressing one does. The fill behind the
    chosen option is a piece of its own, which slides from the old choice to the new. Drawn
    again with the same options, the control keeps its buttons and only moves the fill. */
function segmented(id, options, current, choose) {
  const box = $(id);
  const labels = options.map(([, label]) => label).join('\n');
  if (box.dataset.options !== labels) {
    box.dataset.options = labels;
    box.replaceChildren(
      el('span', 'segmented-fill'),
      ...options.map(([, label], k) => {
        const option = el('button', '', label);
        option.type = 'button';
        option.setAttribute('role', 'radio');
        option.addEventListener('click', () => box.pick(k));
        return option;
      })
    );
    // A control drawn while its page is put away has no sizes yet: the fill finds its place
    // when the page is shown, and follows if the buttons change size.
    box.watch ??= new ResizeObserver(() => placeFill(box));
    box.watch.observe(box);
  }
  box.pick = (k) => choose(options[k][0]);
  [...box.querySelectorAll('button')].forEach((option, k) => {
    const [value, , off] = options[k];
    option.classList.toggle('current', value === current);
    option.setAttribute('aria-checked', String(value === current));
    option.disabled = Boolean(off);
  });
  placeFill(box);
}

/** Puts a segmented control's fill behind its chosen option. It slides there, unless it was
    not on show before: then it is simply there. A choice that is out of reach has no fill. */
function placeFill(box) {
  const fill = box.querySelector('.segmented-fill');
  const chosen = box.querySelector('button.current:not(:disabled)');
  const shown = Boolean(chosen) && box.offsetWidth > 0;
  fill.classList.toggle('away', !shown);
  if (!shown) {
    box.placed = false;
    return;
  }
  if (!box.placed) fill.style.transition = 'none';
  fill.style.width = chosen.offsetWidth + 'px';
  fill.style.transform = `translateX(${chosen.offsetLeft}px)`;
  if (!box.placed) {
    fill.getBoundingClientRect(); // takes its place before it may move again
    fill.style.transition = '';
    box.placed = true;
  }
}

function renderGeneral() {
  $('number-tweets').setAttribute('aria-checked', String(numbering()));
  segmented('limits', LIMITS.map((n) => [n, n.toLocaleString('en-US')]), LIMIT, (n) => {
    LIMIT = n;
    localStorage.setItem('limit', String(n));
    renderGeneral();
  });
  segmented('text-sizes', TEXT_SIZES.map(([id, name]) => [id, name]), applyTextSize(), (id) => {
    localStorage.setItem('text-size', id);
    applyTextSize();
    renderGeneral();
  });
}

$('number-tweets').addEventListener('click', () => {
  if (numbering()) localStorage.removeItem('number-tweets');
  else localStorage.setItem('number-tweets', '1');
  renderGeneral();
});

/** Shows where the storms are kept. */
async function showFolder(now) {
  const { path, shown } = now ?? (await window.api.folder());
  $('folder-path').textContent = shown;
  $('folder-path').dataset.tip = path;
}
$('folder-show').addEventListener('click', () => window.api.showFolder());
$('folder-change').addEventListener('click', async () => {
  const now = await window.api.chooseFolder();
  // Another folder is another set of storms: the window starts again on what is in it.
  if (now.changed) location.reload();
});
showFolder();

// ---------- settings: About ----------

window.api.appInfo().then(({ version }) => ($('about-version').textContent = 'version ' + version));
for (const button of document.querySelectorAll('[data-open]')) button.addEventListener('click', () => window.api.openPlace(button.dataset.open));

// ---------- settings: Intelligence ----------
// The Intelligence page (its section is still called `ai` in the code) lists the ways Storm can reach a model, and the model it asks. Connect opens a
// dialog that works through three steps by itself: the tool is installed, it is signed in (the
// tool opens its own page in the browser), and it has answered. Only an answer makes it a held
// connection. Several can be held; each has a switch, and a menu to connect again or let go.

/** What main last reported: `{ providers, model }`. Each provider says whether it is held
    (`connected`), switched on (`enabled`) and what `models` it offers; its `installed` is
    undefined until this Mac has been looked over. `model` is the one requests go to. */
let ai = null;
/** The connection being made in the dialog, or null:
    `{ id, key, phase, installed, version, signedIn, error, ms }`, where phase is one of
    'looking', 'install', 'signin', 'checking', 'done', 'failed-signin' and 'failed-check'. */
let connecting = null;

const TODO_ICON = 'M12.5 8a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0z';
const DONE_ICON = 'M3.5 8.5l3 3 6-7';

/** Where a provider's tool stands, in a word or two; nothing when it is held and well. */
function aiState(p) {
  if (p.installed === undefined) return p.connected ? '' : 'Checking…';
  if (!p.installed) return 'Not installed';
  if (!p.signedIn) return 'Not signed in';
  return p.connected ? '' : 'Ready';
}

/** A button on the AI page or in its dialog. */
function aiButton(label, onClick) {
  const button = el('button', 'btn', label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

// Lucide "refresh-cw", "log-out" and "pencil".
const RECONNECT_ICON = 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5';
const DISCONNECT_ICON = 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9';
const EDIT_ICON = 'M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5zM15 5l4 4';

/** What a model added by its address is, in a line: the model, and where it is reached. */
const apiWords = (p) => `${p.models[0]?.name || p.model}, ${p.local ? 'on this Mac' : p.hasKey ? 'with your API key' : `at ${p.host}`}.`;

/** Puts the small menu by a button on the AI page, its right edge on the button's: under
    the button, or over it when there is no room below. The menu is not on screen yet, so its
    height is worked out from its lines (28px each, a heading 29px, 10px of edge). */
function placeAiMenu(anchor, ...items) {
  menuEl.replaceChildren(...items);
  const r = anchor.getBoundingClientRect();
  const lines = items.reduce((sum, item) => sum + (item.classList.contains('picker-label') ? 29 : 28), 10);
  const height = Math.min(lines, 420, window.innerHeight - 80);
  const below = r.bottom + 4;
  menuEl.style.left = Math.max(8, r.right - MENU_WIDTH) + 'px';
  menuEl.style.top = (below + height <= window.innerHeight - 8 ? below : Math.max(8, r.top - 4 - height)) + 'px';
}

/** A button that opens the small menu, filled by `fill(button)` each time it opens. */
function opensAiMenu(button, fill) {
  button.popoverTargetElement = menuEl; // the button opens and closes the menu; a click on it never counts as "outside"
  button.addEventListener('click', (e) => {
    const open = menuEl.matches(':popover-open');
    if (open && menuEl.dataset.owner === button.id) return; // a second click closes it
    if (open) e.preventDefault(); // open for something else: bring it here rather than close it
    menuEl.dataset.owner = button.id;
    fill(button);
  });
}

function renderAI() {
  if (!ai) return;
  $('ai-providers').replaceChildren(
    ...ai.providers.map((p) => {
      const row = el('div', 'settings-row');
      const words = el('div');
      words.append(el('div', 'row-title', p.name), el('div', 'row-help', p.api ? apiWords(p) : `Your ${p.name} subscription, through ${p.tool}.`));
      const actions = el('div', 'row-actions');
      const state = aiState(p);
      if (state) actions.append(el('span', 'row-state', state));

      if (!p.connected) {
        actions.append(aiButton('Connect', () => connectAI(p.id)));
      } else {
        // Held: a switch to use it or rest it, and a menu to connect again or let it go.
        const toggle = el('button', 'switch');
        toggle.type = 'button';
        toggle.setAttribute('role', 'switch');
        toggle.setAttribute('aria-checked', String(p.enabled));
        toggle.setAttribute('aria-label', `Use ${p.name}`);
        toggle.addEventListener('click', async () => {
          ai = await window.api.aiEnable(p.id, !p.enabled);
          renderAI();
        });
        const more = el('button', 'btn icon');
        more.type = 'button';
        more.id = `ai-more-${p.id}`;
        more.dataset.tip = 'More';
        more.setAttribute('aria-label', `More for ${p.name}`);
        const dots = icon(DOTS_ICON, 16, 24);
        dots.classList.add('dots'); // keeps its own line weight
        dots.setAttribute('stroke-width', '3.4');
        more.append(dots);
        opensAiMenu(more, () => {
          const disconnect = menuItem(DISCONNECT_ICON, 'Disconnect', async () => {
            ai = await window.api.aiDisconnect(p.id);
            renderAI();
          });
          disconnect.classList.add('danger');
          placeAiMenu(more, p.api ? menuItem(EDIT_ICON, 'Edit', () => addModel(p)) : menuItem(RECONNECT_ICON, 'Reconnect', () => connectAI(p.id)), disconnect);
        });
        actions.append(toggle, more);
      }
      row.append(words, actions);
      return row;
    }),
    addRow()
  );

  // The model: one of those the switched-on connections offer.
  const offering = ai.providers.filter((p) => p.enabled && p.models.length);
  $('ai-model').disabled = !offering.length; // nothing to choose from without a connection
  $('ai-model-name').textContent = offering.length && ai.model ? ai.model.name : 'No connection';

  // Reasoning: how hard the model in use thinks. A level it does not take cannot be chosen;
  // a model that takes none leaves the whole choice out of reach.
  const chosen = ai.levels.includes(ai.effort) ? ai.effort : null;
  $('ai-effort-help').textContent = ai.levels.length || !ai.model ? 'How much the model thinks before it replies.' : 'Not available for this model.';
  const levels = [[null, 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
  segmented('ai-effort', levels.map(([level, label]) => [level, label, !ai.levels.length || (level !== null && !ai.levels.includes(level))]), chosen, async (level) => {
    ai = await window.api.aiEffort(level);
    renderAI();
  });
}

/** The last row of the connections: the way to a model reached by its address. */
function addRow() {
  const row = el('div', 'settings-row');
  const words = el('div');
  words.append(el('div', 'row-title', 'Another model'), el('div', 'row-help', 'With an API key, or running on this Mac.'));
  const actions = el('div', 'row-actions');
  actions.append(aiButton('Add', () => addModel()));
  row.append(words, actions);
  return row;
}

// The model menu: each switched-on connection's models under its name, the one in use ticked.
// Models added from the same place stand under one heading.
opensAiMenu($('ai-model'), (button) => {
  const items = [];
  let heading = null;
  for (const p of ai.providers.filter((x) => x.enabled && x.models.length)) {
    if (p.name !== heading) items.push(el('div', 'picker-label', (heading = p.name)));
    for (const m of p.models) {
      const chosen = ai.model?.provider === p.id && ai.model.id === m.id;
      const item = menuItem(CHECK_ICON, m.name, async () => {
        ai = await window.api.aiModel(p.id, m.id);
        renderAI();
      });
      if (!chosen) item.classList.add('unticked');
      items.push(item);
    }
  }
  placeAiMenu(button, ...items);
});

/** Looks over this Mac again and redraws. Until the first look is back, the page shows the
    providers with their state still unknown. */
let aiLooking = null;
async function refreshAI() {
  if (!ai) {
    ai = await window.api.aiList();
    renderAI();
  }
  aiLooking ??= window.api.aiStatus().finally(() => (aiLooking = null));
  ai = await aiLooking;
  renderAI();
  return ai;
}

/** Connects a provider, in the dialog: looks for its tool, signs in if it is not signed in (or
    if `signInAgain` asks for it, after a sign-in that turned out to have run out), then sends
    one short message. Each wait can be called off by closing the dialog. */
async function connectAI(id, signInAgain = false) {
  if (connecting) window.api.cancelAsk(connecting.key);
  const run = (connecting = { id, key: `connect-${Date.now()}`, phase: 'looking' });
  const live = () => connecting === run;
  const step = (phase, more) => {
    Object.assign(run, { phase }, more);
    renderConnecting();
  };
  renderConnecting();
  if (!$('ai-dialog').open) $('ai-dialog').showModal();

  const p = (await refreshAI()).providers.find((x) => x.id === id);
  if (!live()) return;
  Object.assign(run, { installed: p.installed, version: p.version, signedIn: p.signedIn && !signInAgain });
  if (!p.installed) return step('install');

  if (!run.signedIn) {
    step('signin');
    const signed = await window.api.aiSignIn(run.key, id);
    if (!live()) return;
    if (!signed.ok) return step('failed-signin', { error: signed.error });
    run.signedIn = true;
  }

  step('checking');
  const reply = await window.api.aiConnect(run.key, id);
  if (!live()) return;
  step(reply.ok ? 'done' : 'failed-check', { ms: reply.ms, error: reply.error });
  refreshAI();
}

/** The mark of a step that is under way: a small square of nine dots with a light running
    round its edge. */
function aiWaiting() {
  const dots = el('span', 'waiting');
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 9; i++) dots.append(el('i'));
  return dots;
}

/** One step in the dialog: a mark (a ring, the nine dots while it is under way, a tick once it
    is done), what it is, where it stands, and what can be done about it. */
function aiStep(state, title, text, ...actions) {
  const row = el('div', 'step ' + state);
  const words = el('div', 'step-words');
  words.append(el('div', 'row-title', title), el('div', 'row-help' + (state === 'failed' ? ' error' : ''), text));
  const buttons = el('div', 'row-actions');
  buttons.append(...actions.filter(Boolean));
  row.append(state === 'busy' ? aiWaiting() : icon(state === 'done' ? DONE_ICON : TODO_ICON, 16), words, buttons);
  return row;
}

function renderConnecting() {
  const run = connecting;
  if (!run) return;
  const p = ai.providers.find((x) => x.id === run.id);
  const { phase } = run;
  $('ai-dialog-title').textContent = `Connect ${p.name}`;
  $('ai-dialog-sub').textContent = `Use your own ${p.name} subscription, through ${p.tool}.`;
  $('ai-dialog').classList.remove('adding');
  $('ai-dialog-go').hidden = true;

  const tool =
    phase === 'looking'
      ? aiStep('busy', p.tool, 'Looking for it on this Mac…')
      : run.installed
        ? aiStep('done', p.tool, run.version ? `Version ${run.version}` : 'Installed')
        : aiStep('todo', p.tool, 'Not found on this Mac.', aiButton(`Get ${p.tool}`, () => window.api.aiPage(p.id)));

  const account =
    phase === 'signin'
      ? aiStep('busy', 'Account', 'Finish signing in on the page that opened in your browser.')
      : phase === 'failed-signin'
        ? aiStep('failed', 'Account', run.error, aiButton('Try again', () => connectAI(p.id, true)))
        : run.signedIn
          ? aiStep('done', 'Account', 'Signed in.', phase === 'failed-check' && aiButton('Sign in again', () => connectAI(p.id, true)))
          : aiStep('todo', 'Account', `Sign in with your ${p.name} account.`);

  const connection =
    phase === 'checking'
      ? aiStep('busy', 'Connection', 'Waiting for a reply…')
      : phase === 'failed-check'
        ? aiStep('failed', 'Connection', run.error, aiButton('Try again', () => connectAI(p.id)))
        : phase === 'done'
          ? aiStep('done', 'Connection', `${p.name} replied in ${(run.ms / 1000).toFixed(1)} s.`)
          : aiStep('todo', 'Connection', 'One short message, to check it answers.');

  $('ai-dialog-steps').replaceChildren(tool, account, connection);
  $('ai-dialog-close').textContent = phase === 'done' ? 'Done' : 'Cancel';
}

// ---------- adding a model by its address ----------
// The same dialog, as a form: an address (typed, or one of the ready-made ones), an API key
// if the address wants one, and the model's name, with the models the address lists offered
// under the field as it is typed. Connect sends one short message; a reply adds the model.

/** The form that is open: what is typed, the models offered, and where the check stands
    ('form', 'checking', 'done' or 'failed'). */
let adding = null;
const LOCAL_ADDRESS = /^(https?:\/\/)?(localhost|127\.|0\.0\.0\.0|\[::1\])/i;

/** A field of the form: its name, then a box to type in. */
function apiField(name, placeholder, type = 'text') {
  const field = el('label', 'api-field');
  const box = el('span', 'ask-field');
  const input = el('input', 'ask-input');
  input.type = type;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.placeholder = placeholder;
  box.append(input);
  field.append(el('span', 'api-field-name', name), box);
  return { field, input };
}

/** Opens the form: empty, or holding a model already added (`held`), whose key stays kept
    unless another is typed. */
function addModel(held = null) {
  if (connecting) window.api.cancelAsk(connecting.key);
  connecting = null;
  const run = (adding = { key: `add-${Date.now()}`, id: held?.id, phase: 'form', models: [], listedFor: null, picked: -1 });
  const live = () => adding === run;

  $('ai-dialog-title').textContent = held ? `Edit ${held.name}` : 'Add a model';
  $('ai-dialog-sub').textContent = 'With an API key, or running on this Mac.';
  $('ai-dialog').classList.add('adding');

  const presets = el('div', 'api-presets');
  const address = apiField('Address', 'https://example.com/v1');
  const key = apiField('API key', '', 'password');
  const model = apiField('Model', 'Its name');
  const list = el('div', 'ask-list api-models');
  const check = el('div', 'api-check');
  address.input.value = held?.url || '';
  model.input.value = held?.model || '';
  $('ai-dialog-steps').replaceChildren(presets, address.field, key.field, model.field, list, check);

  const go = $('ai-dialog-go');
  const draft = () => ({ id: run.id, url: address.input.value.trim(), key: key.input.value.trim(), model: model.input.value.trim() });
  /** The key already kept counts for as long as the address is the one it was given for. */
  const keyKept = () => Boolean(held?.hasKey) && draft().url.replace(/\/+$/, '') === held.url;

  let shown = [];
  const draw = () => {
    const { url, model: typed } = draft();
    key.input.placeholder = keyKept() ? 'Kept in the Keychain' : LOCAL_ADDRESS.test(url) ? 'Not needed on this Mac' : '';
    const low = typed.toLowerCase();
    const exact = run.models.some((m) => m.id.toLowerCase() === low);
    shown = run.phase === 'done' || exact ? [] : run.models.filter((m) => !low || m.id.toLowerCase().includes(low) || m.name.toLowerCase().includes(low));
    run.picked = Math.max(-1, Math.min(run.picked, shown.length - 1));
    list.replaceChildren(
      ...shown.map((m, k) => {
        const item = el('button', 'ask-item' + (k === run.picked ? ' picked' : ''), m.id);
        item.type = 'button';
        item.tabIndex = -1;
        item.addEventListener('click', () => pick(m));
        return item;
      })
    );
    list.hidden = !shown.length;
    list.querySelector('.picked')?.scrollIntoView({ block: 'nearest' });

    const { phase } = run;
    check.replaceChildren(
      phase === 'checking'
        ? aiStep('busy', 'Connection', 'Waiting for a reply…')
        : phase === 'failed'
          ? aiStep('failed', 'Connection', run.error)
          : phase === 'done'
            ? aiStep('done', 'Connection', `${run.asked} replied in ${(run.ms / 1000).toFixed(1)} s.`)
            : aiStep('todo', 'Connection', 'One short message, to check it answers.')
    );
    go.hidden = phase === 'done';
    go.disabled = phase === 'checking' || !url || !typed; // nothing to connect without an address and a model
    $('ai-dialog-close').textContent = phase === 'done' ? 'Done' : 'Cancel';
  };
  const pick = (m) => {
    model.input.value = m.id;
    run.picked = -1;
    edited();
    model.input.focus();
  };
  /** Anything typed after a check puts the check back to be done. */
  const edited = () => {
    if (run.phase !== 'checking') run.phase = 'form';
    draw();
  };

  /** Asks the address for its models, once for each address and key. Quietly: an address
      that will not say only leaves the model to be typed in full. */
  const listModels = async () => {
    const { url, key: typedKey } = draft();
    const asked = `${url}\n${typedKey}`;
    if (!url || run.listedFor === asked) return;
    run.listedFor = asked;
    window.api.cancelAsk(run.key + '-list');
    const reply = await window.api.aiEndpointModels(run.key + '-list', draft());
    if (!live() || run.listedFor !== asked || reply.cancelled) return;
    run.models = reply.ok ? reply.models : [];
    draw();
  };

  const connect = async () => {
    if (go.disabled || go.hidden) return;
    const sent = draft();
    Object.assign(run, { phase: 'checking', asked: sent.model, picked: -1 });
    draw();
    const reply = await window.api.aiSaveEndpoint(run.key, sent);
    if (!live() || reply.cancelled) return;
    Object.assign(run, { phase: reply.ok ? 'done' : 'failed', ms: reply.ms, error: reply.error });
    draw();
    if (reply.ok) refreshAI();
  };
  go.onclick = connect;

  presets.append(
    ...ai.presets.map((preset) => {
      const chip = el('button', 'ask-chip', preset.name);
      chip.type = 'button';
      chip.addEventListener('click', () => {
        if (address.input.value.trim() !== preset.url) model.input.value = ''; // another place, other models
        address.input.value = preset.url;
        run.models = [];
        edited();
        (LOCAL_ADDRESS.test(preset.url) || keyKept() ? model : key).input.focus();
      });
      return chip;
    })
  );
  list.addEventListener('mousedown', (e) => e.preventDefault()); // a click on a model leaves the field its caret
  for (const { input } of [address, key, model]) {
    input.addEventListener('input', () => {
      if (input !== model.input) run.models = []; // they were another address's, or another key's
      run.picked = -1;
      edited();
    });
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (input === model.input && run.picked >= 0) pick(shown[run.picked]);
        else connect();
      } else if (input === model.input && shown.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        run.picked = Math.max(-1, Math.min(run.picked + (e.key === 'ArrowDown' ? 1 : -1), shown.length - 1));
        draw();
      }
    });
  }
  model.input.addEventListener('focus', listModels);

  draw();
  if (!$('ai-dialog').open) $('ai-dialog').showModal();
  (held ? model : address).input.focus();
}

// Closing the dialog, by its button or Escape, calls off whatever it was waiting for.
$('ai-dialog-close').addEventListener('click', () => $('ai-dialog').close());
$('ai-dialog').addEventListener('close', () => {
  if (connecting) window.api.cancelAsk(connecting.key);
  connecting = null;
  if (adding) {
    window.api.cancelAsk(adding.key);
    window.api.cancelAsk(adding.key + '-list');
  }
  adding = null;
  if (sectionId === 'ai') refreshAI();
});

// Back in Storm after installing a tool or changing something outside it: look again.
window.addEventListener('focus', () => {
  if (connecting?.phase === 'install') connectAI(connecting.id);
  else if (!connecting && document.body.classList.contains('in-settings') && sectionId === 'ai') refreshAI();
});

/** Opens the settings tab, or goes to it if it is already open. */
// ---------- settings: Intelligence, the ready questions and the kept replies ----------

/** The Prompts list, drawn as the questions stand in the ask card: each a button's shape with
    a cross to take it away. A last button adds one: it turns into a field, and Return keeps
    what is typed (asked as it is written) and leaves the field open for another. If the list
    is no longer as it came, a second button puts it back. */
const ADD_ICON = 'M8 3v10M3 8h10';
let addingPrompt = false;
function renderPrompts() {
  const asks = readyAsks();
  const chips = asks.map((a, k) => {
    const chip = el('span', 'prompt');
    const remove = el('button', 'prompt-x');
    remove.type = 'button';
    remove.dataset.tip = 'Remove';
    remove.setAttribute('aria-label', `Remove "${a.label}"`);
    remove.append(icon(CLOSE_ICON, 12));
    remove.addEventListener('click', () => {
      hideTip();
      saveAsks(asks.filter((_, at) => at !== k));
      renderPrompts();
    });
    chip.append(el('span', 'prompt-name', a.label), remove);
    return chip;
  });

  if (addingPrompt) {
    const input = el('input', 'prompt-input');
    input.type = 'text';
    input.placeholder = 'Add a prompt';
    input.setAttribute('aria-label', 'Add a prompt');
    input.maxLength = 120;
    const keep = () => {
      const typed = input.value.trim();
      if (typed && !asks.some((a) => a.label.toLowerCase() === typed.toLowerCase())) saveAsks([...asks, { label: typed, ask: typed }]);
      return typed;
    };
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!keep()) return;
        input.dataset.kept = '1'; // redrawing takes this field away: that is not a click elsewhere
        renderPrompts();
        $('ai-prompts').querySelector('.prompt-input').focus(); // ready for the next one
      } else if (e.key === 'Escape') {
        e.preventDefault();
        addingPrompt = false;
        renderPrompts();
      }
    });
    // Clicking away keeps what was typed and closes the field.
    input.addEventListener('blur', () => {
      if (!addingPrompt || input.dataset.kept) return;
      addingPrompt = false;
      keep();
      renderPrompts();
    });
    chips.push(input);
  } else {
    const add = el('button', 'prompt-more');
    add.type = 'button';
    add.append(icon(ADD_ICON, 12), 'Add');
    add.addEventListener('click', () => {
      addingPrompt = true;
      renderPrompts();
      $('ai-prompts').querySelector('.prompt-input').focus();
    });
    chips.push(add);
    if (!sameAsks(asks, OWN_ASKS)) {
      const restore = el('button', 'prompt-more');
      restore.type = 'button';
      restore.dataset.tip = "Put back Storm's own prompts";
      restore.append(icon(RESET_ICON, 12, 24), 'Restore');
      restore.addEventListener('click', () => {
        hideTip();
        saveAsks(OWN_ASKS);
        renderPrompts();
      });
      chips.push(restore);
    }
  }
  const row = el('div', 'prompts');
  row.append(...chips);
  $('ai-prompts').replaceChildren(row);
}

const keptCount = () => storms.reduce((n, s) => n + [...(s.notes?.values() ?? [])].filter((note) => note.saved).length, 0);

function renderKept() {
  const n = keptCount();
  $('kept-count').textContent = `${n || 'No'} ${n === 1 ? 'reply is' : 'replies are'} kept.`;
  $('kept-forget').disabled = !n;
}

$('kept-forget').addEventListener('click', async () => {
  for (const s of storms) {
    for (const [at, note] of s.notes ?? []) {
      note.saved = null;
      if (note.phase === 'done') s.notes.delete(at); // it was showing, or holding, only that reply
    }
  }
  await window.api.clearAsks();
  renderKept();
});

function openSettings() {
  if (!tabs.includes(SETTINGS)) tabs.push(SETTINGS);
  show(tabs.indexOf(SETTINGS));
}

$('settings-back').addEventListener('click', () => closeTab(tabs.indexOf(SETTINGS)));

$('wallpaper-choose').addEventListener('click', async () => {
  const w = await window.api.chooseWallpaper();
  if (w) applyWallpaper(w);
});
$('wallpaper-none').addEventListener('click', async () => applyWallpaper(await window.api.clearWallpaper()));

// ---------- tooltips ----------
// A label and its shortcut in a soft dark pill under the control, shown after a short pause.

const tipEl = $('tip');
let tipFor = null;
let tipTimer = null;

function hideTip() {
  clearTimeout(tipTimer);
  tipFor = null;
  tipEl.classList.remove('on');
}

function showTip(target) {
  tipEl.replaceChildren(el('span', '', target.dataset.tip));
  if (target.dataset.keys) tipEl.append(el('span', 'keys', target.dataset.keys));
  tipEl.classList.add('on');
  const r = target.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  const below = r.bottom + 8;
  tipEl.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8)) + 'px';
  tipEl.style.top = (below + h > window.innerHeight - 8 ? r.top - h - 8 : below) + 'px';
}

document.addEventListener('mouseover', (e) => {
  let target = e.target.closest('[data-tip]');
  if (target && (target.disabled || target.classList.contains('off'))) target = null; // nothing to explain on a control that is off
  if (target && document.querySelector(':popover-open')) target = null; // a menu is open: a tooltip would sit across it
  if (document.body.classList.contains('sorting')) target = null; // something is being dragged into place
  if (target === tipFor) return;
  hideTip();
  if (!target) return;
  tipFor = target;
  tipTimer = setTimeout(() => showTip(target), 350);
});
document.addEventListener('mousedown', hideTip);
document.documentElement.addEventListener('mouseleave', hideTip);

// ---------- wiring ----------

$('new').addEventListener('click', newStorm);
$('toggle-sidebar').addEventListener('click', toggleSidebar);
$('open-settings').addEventListener('click', openSettings);

const MENU = {
  'new-storm': newStorm,
  'open-tab': togglePicker,
  'close-tab': () => closeTab(active),
  'next-tab': () => cycleTab(1),
  'previous-tab': () => cycleTab(-1),
  'toggle-sidebar': toggleSidebar,
  search: openSearch,
  find: openFind,
  post: startPosting,
  ask: () => openAsk(),
  // In a tweet, Undo and Redo step through the storm's history; in any other field
  // (search, find, a name being typed) they are that field's own.
  undo: () => (cur && !(document.activeElement instanceof HTMLInputElement) ? stepHistory(true) : document.execCommand('undo')),
  redo: () => (cur && !(document.activeElement instanceof HTMLInputElement) ? stepHistory(false) : document.execCommand('redo')),
  settings: openSettings,
};
window.api.onMenu((action) => MENU[action]?.());

setInterval(renderList, 60e3);

(async function init() {
  if (localStorage.getItem('sidebar') === 'collapsed') document.body.classList.add('collapsed');

  const files = await window.api.list();
  storms = files.map((f) => ({ id: f.id, ...parse(f.text), mtime: f.mtime, onDisk: true }));
  loadNotes(await window.api.loadAsks());
  // Images no storm points to any more are cleared out now, before any Undo could want them back.
  window.api.sweepMedia(Object.fromEntries(storms.map((s) => [s.id, s.media.flat()])));

  // Reopen the tabs from last time; failing that, the most recent storm, or a blank one.
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem('tabs')) || {};
  } catch {
    saved = {};
  }
  tabs = (saved.ids || []).map((id) => (id === SETTINGS.id ? SETTINGS : storms.find((s) => s.id === id))).filter(Boolean);
  if (!tabs.length) {
    const latest = [...storms].sort((a, b) => b.mtime - a.mtime)[0];
    tabs = [latest ?? blankStorm()];
  }
  show(Math.min(Math.max(0, saved.active | 0), tabs.length - 1));

  applyWallpaper(await window.api.wallpaper());
})();
