import { Wallpaper } from './wallpaper.js';

const LIMIT = 280;
const URL_LENGTH = 23;
const SEP = '\n\n---\n\n';
const LINE_HEIGHT = 24;

const $ = (id) => document.getElementById(id);
const listEl = $('list');
let query = ''; // what the sidebar's search field holds, in lower case; empty when not searching
const tabsEl = $('tabs');
const tweetsEl = $('tweets');
const statusEl = $('status');
const measureEl = $('measure');

/** @typedef {{id: string, name: string, tweets: string[], mtime: number, onDisk: boolean}} Storm */
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

function serialize(s) {
  const body = s.tweets.map((t) => t.replace(/^(\\*)---$/gm, '\\$1---')).join(SEP);
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
  return { name, tweets: body.split(SEP).map((t) => t.replace(/^\\(\\*---)$/gm, '$1')) };
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
const isEmpty = (s) => s.tweets.every((t) => !t.trim());
/** Nothing to keep: no words and no name. Such a storm has no file and no place in the list. */
const isBlank = (s) => isEmpty(s) && !s.name;
const tweetCount = (s) => s.tweets.filter((t) => t.trim()).length;
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
  const s = { id: newId(), name: '', tweets: [''], mtime: Date.now(), onDisk: false };
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

function setStatus(state) {
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
    With a `scroller`, holding the drag near its top or bottom edge scrolls it. */
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
  const scrolled = scroller ? scroller.scrollTop : 0;
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
    const d = Math.max(least, Math.min(most, pointer - start + (scroller ? scroller.scrollTop - scrolled : 0)));
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

  // Near the scroller's top or bottom edge the page creeps along, faster the closer the pointer is.
  const creep = () => {
    frame = 0;
    if (!dragging) return;
    const box = scroller.getBoundingClientRect();
    const over = Math.max(0, pointer - (box.bottom - SORT_EDGE)) - Math.max(0, box.top + SORT_EDGE - pointer);
    if (over) {
      scroller.scrollTop += Math.max(-16, Math.min(16, over / 4));
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
  if (!cur) closeFind(false); // the settings page has nothing to find in
  document.body.classList.toggle('in-settings', !cur);
  renderTabs();
  renderList();
  if (cur) renderTweets();
  else renderSettings();
  setStatus('saved');
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

/** Fills the three-dots menu for a storm and puts it under that storm's button. */
function openMenu(s, anchor) {
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
  menuEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - MENU_WIDTH - 8)) + 'px';
  menuEl.style.top = r.bottom + 4 + 'px';
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

function renderTweets() {
  locate(); // what Find is looking for, in the storm as it now stands
  tweetsEl.replaceChildren(...cur.tweets.map((_, i) => buildTweet(i)));
  syncHints();
  syncFindBar();
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
  ta.placeholder = i === 0 ? 'Start your storm' : 'Keep writing';
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
  const copy = el('button', 'copy');
  copy.type = 'button';
  copy.dataset.tip = 'Copy tweet';
  copy.setAttribute('aria-label', 'Copy tweet');
  copy.append(icon(COPY_ICON, 14, 24));
  gutter.append(el('div', 'count'), el('div', 'excess'));
  row.append(num, field, copy, gutter);

  ta.addEventListener('input', () => {
    cur.tweets[i] = ta.value;
    if (find.open) refreshFind(false); // the matches move as the words do
    else refreshTweet(row, i);
    touch();
  });
  ta.addEventListener('keydown', (e) => onKey(e, ta, i));
  copy.addEventListener('click', async () => {
    await window.api.copy(cur.tweets[i].trim());
    copy.replaceChildren(icon(CHECK_ICON, 14, 24)); // a tick, for a moment, to say it worked
    setTimeout(() => copy.replaceChildren(icon(COPY_ICON, 14, 24)), 1200);
  });

  refreshTweet(row, i);
  return row;
}

function refreshTweet(row, i) {
  const text = cur.tweets[i];
  const { count, overAt } = measure(text);
  const over = count > LIMIT;

  paintBackdrop(row.querySelector('.backdrop'), text, over ? overAt : Infinity, i);

  row.classList.toggle('over', over);
  row.querySelector('.count').textContent = String(count);
  row.querySelector('.excess').textContent = over ? `${count - LIMIT} over` : '';
  row.querySelector('.copy').hidden = !text.trim();
}

/** Moves a tweet to a new place in the storm, keeping the caret in the tweet it was in. */
function moveTweet(from, to) {
  const areas = [...tweetsEl.querySelectorAll('textarea')];
  const held = areas.indexOf(document.activeElement);
  const selection = held >= 0 ? [areas[held].selectionStart, areas[held].selectionEnd] : null;
  cur.tweets.splice(to, 0, ...cur.tweets.splice(from, 1));
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
  const text = ta.value;
  cur.tweets.splice(i, 1, text.slice(0, ta.selectionStart).trimEnd(), text.slice(ta.selectionEnd).trimStart());
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
  const a = cur.tweets[i - 1];
  const b = cur.tweets[i];
  const joiner = a && b && !/\s$/.test(a) && !/^\s/.test(b) ? ' ' : '';
  cur.tweets.splice(i - 1, 2, a + joiner + b);
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
  } else if (e.key === 'Enter' && e.metaKey) {
    e.preventDefault();
    if (!isEmpty(cur)) splitTweet(ta, i); // like its button, it waits for the first words
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
  if (button.dataset.act === 'new-storm') return newStorm();
  if (button.dataset.act === 'merge-up') return mergeUp(i);
  if (!focused) focusTweet(i, Infinity);
  splitTweet(ta, i);
});
tweetsEl.addEventListener('focusin', syncHints);

// Clicking the empty page below the storm puts the caret at its end.
$('scroll').addEventListener('mousedown', (e) => {
  if (e.target.closest('.tweet') || e.target.closest('#hints') || !cur) return;
  e.preventDefault();
  focusTweet(cur.tweets.length - 1, Infinity);
});

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
  const now = currentEffect();
  $('wallpaper-effects').replaceChildren(
    ...EFFECTS.map(([id, name]) => {
      const option = el('button', id === now ? 'current' : '', name);
      option.type = 'button';
      option.disabled = !hasWallpaper; // nothing to draw without an image
      option.setAttribute('role', 'radio');
      option.setAttribute('aria-checked', String(id === now));
      option.addEventListener('click', () => {
        localStorage.setItem('wallpaper-effect', id);
        Wallpaper.setEffect(id);
        renderEffects();
      });
      return option;
    })
  );
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
  renderAppearance();
}

/** Opens the settings tab, or goes to it if it is already open. */
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
  settings: openSettings,
};
window.api.onMenu((action) => MENU[action]?.());

setInterval(renderList, 60e3);

(async function init() {
  if (localStorage.getItem('sidebar') === 'collapsed') document.body.classList.add('collapsed');

  const files = await window.api.list();
  storms = files.map((f) => ({ id: f.id, ...parse(f.text), mtime: f.mtime, onDisk: true }));

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
