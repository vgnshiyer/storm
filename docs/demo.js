'use strict';

// A small copy of Storm that runs in the page: the top bar with its tabs, the sidebar, and a
// storm you can write in. It keeps the app's behaviour for the parts it has (the wallpaper
// behind a storm that hasn't been started, the count, splitting and merging, tabs, asking
// about a tweet) and leaves the rest out. Nothing typed here is saved or sent anywhere, and
// there is no model behind Ask: its replies are written examples, and say so.

(() => {
  const figure = document.getElementById('demo');
  if (!figure) return;

  // ---------- counting, as the app counts ----------
  // Follows X's weighting: links count 23, emoji 2, most Latin text 1, CJK and the rest 2.
  const LIMIT = 280;
  const URL_LENGTH = 23;
  const URL_RE = /https?:\/\/[^\s]+/gi;
  const EMOJI_RE = /\p{Extended_Pictographic}/u;
  const segmenter = 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const graphemes = (text) =>
    segmenter ? [...segmenter.segment(text)].map((s) => [s.segment, s.index]) : [...text].map((ch, i, all) => [ch, all.slice(0, i).join('').length]);
  const codePointWeight = (cp) => (cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247) ? 1 : 2);
  function graphemeWeight(g) {
    if (EMOJI_RE.test(g)) return 2;
    let w = 0;
    for (const ch of g) w += codePointWeight(ch.codePointAt(0));
    return w;
  }
  /** The weighted length, and the index where the tweet first goes over (or -1). */
  function measure(raw) {
    const text = raw.trimEnd();
    let count = 0;
    let overAt = -1;
    const add = (weight, index) => {
      count += weight;
      if (overAt < 0 && count > LIMIT) overAt = index;
    };
    const plain = (from, to) => {
      for (const [g, at] of graphemes(text.slice(from, to))) add(graphemeWeight(g), from + at);
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

  // ---------- the storms ----------
  const HOOK = 'I shipped six side projects on weekends this year. Most died. Here is what the two that lived had in common 🧵';
  const ELON_HOOK = "Read @EricJorgenson's Book of Elon. Absolutely loved it! Here are my notes, insights, learnings from it.\n\n🧵👇";
  const USEFUL =
    '1/ Be Useful\n\nthe measure of success in life is not how famous you are. it’s how many useful things you have done. don’t aspire for glory. aspire for being useful.\n\nevery morning ask. "How can i be useful today?"\n\nA useful life is worth having lived';
  const storms = [
    {
      name: 'Book of Elon',
      when: 'Nov 1',
      tweets: [ELON_HOOK, USEFUL, ''], // an empty third tweet, ready for the next note
    },
    {
      name: 'Shipping on weekends',
      when: 'Sat',
      tweets: [
        HOOK,
        '1/ They solved my own problem first. I used both every day before anyone else saw them, so I never had to guess what to build next.',
        '2/ They were embarrassingly small at launch. One screen, one job. The ones I polished for months never shipped at all.',
        '3/ I wrote about them while I built them. Every post brought in one or two people who cared, and those people told me what was broken.',
      ],
    },
    {
      name: 'How to think from first principles?',
      when: 'Oct 12',
      tweets: ['How to think from first principles?\n\nA Guide from the Book of Elon. 🧵', '1/ Break something down to its most fundamental level.'],
    },
  ];
  for (const s of storms) s.notes = new Map();

  // ---------- Ask ----------
  // The app's ready questions. In the app the question and the whole storm go to the connected
  // model; here a few tweets have written example replies (each kept to the tweet's own words,
  // so an edited tweet loses them), and anything else says plainly that this page has no model.
  const READY = ['What do you think?', 'Critique it', 'Tighten it', 'Check the flow'];
  // The same critique as the Ask screenshot on the page.
  const ELON_HOOK_EXAMPLES = {
    'Critique it':
      'The tag and the title tell the reader what this is, and the 🧵👇 says there is more.\n\n"Absolutely loved it!" is what everyone says about a book they finished. One idea from it would give a stranger a reason to open the thread. "notes, insights, learnings" are three words for one thing.\n\n> I read @EricJorgenson’s Book of Elon. The idea I keep coming back to: be useful, not famous. My notes 🧵👇',
  };
  const USEFUL_EXAMPLES = {
    'What do you think?':
      'It lands. One idea, said plainly, and a question the reader can take into their own morning.\n\n"don’t aspire for glory. aspire for being useful." says the line before it again. Without it, "How can i be useful today?" arrives sooner and hits harder.',
  };
  const HOOK_EXAMPLES = {
    'What do you think?':
      'It works. A number, an admission and a promise, in that order, and the reader wants the answer.\n\n"Here is what" slows the last part down. The line can go straight to "what the two that lived had in common".',
    'Critique it':
      'The hook works: a number, an admission, and a promise. "Most died" does most of the work.\n\n"Here is what the two that lived had in common" is long for an opening line, and the count already tells the reader two survived.\n\n> Six weekend projects this year. Four died. What the other two had in common 🧵',
    'Tighten it':
      '"Most died" and "the two that lived" say the same thing twice. Give the numbers once.\n\n> Six weekend projects this year. Two lived. What they had in common 🧵\n\n> Shipped six side projects on weekends. Four died. Here is why two didn’t 🧵',
    'Check the flow':
      'It leads into tweet 2 well: "solved my own problem first" answers the promise straight away.\n\nThe opener promises what the two had in common, and tweets 2 to 4 give one reason each. Saying "three things" up front would tell the reader how long the thread is.',
  };
  const NO_MODEL =
    'This page has no model behind it, so this is where the demo stops. In Storm, your question and the whole storm go to Claude or ChatGPT through your own account, and the reply lands here.';
  const EXAMPLES = new Map([
    [ELON_HOOK, ELON_HOOK_EXAMPLES],
    [USEFUL, USEFUL_EXAMPLES],
    [HOOK, HOOK_EXAMPLES],
  ]);
  function replyFor(s, i, question) {
    const reply = EXAMPLES.get(s.tweets[i])?.[question];
    return reply ? { reply, model: 'example' } : { reply: NO_MODEL, model: '' };
  }
  /** A reply already kept on a tweet, as the app keeps them. */
  const keep = (s, i, question, open) => s.notes.set(i, { open, phase: 'done', saved: { question, ...replyFor(s, i, question) } });
  keep(storms[0], 1, 'What do you think?', true); // Book of Elon opens with it showing under "Be Useful"
  keep(storms[1], 0, 'Critique it', true); // and Shipping on weekends with its critique showing under the hook

  // ---------- state ----------
  // The page opens on two tabs: Book of Elon, then a new storm, which is the one showing.
  const blankStorm = () => ({ name: '', when: 'now', tweets: [''], notes: new Map() });
  const tabs = [storms[0], blankStorm()];
  let active = 1;
  let cur = tabs[active];
  let at = 0; // the tweet the caret was last in

  const isBlank = (s) => s.tweets.every((t) => !t.trim());
  const plural = (n) => `${n} tweet${n === 1 ? '' : 's'}`;
  const count = (s) => s.tweets.filter((t) => t.trim()).length;
  /** A storm goes by its name, or failing that by its first line. */
  function titleOf(s) {
    if (s.name) return s.name;
    for (const t of s.tweets) {
      const line = t.split('\n').find((l) => l.trim());
      if (line) return line.trim();
    }
    return 'New storm';
  }

  // ---------- small builders ----------
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  const SVG = 'http://www.w3.org/2000/svg';
  function icon(d, size, box = 24) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', `0 0 ${box} ${box}`);
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  }
  /** A button with what it is called, and the tooltip the app shows on it (its shortcut only
      where this page answers it: a browser keeps ⌘T, ⌘N and ⌘W for itself). */
  function button(cls, label, glyph, tip = label, keys = '') {
    const b = el('button', cls);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.dataset.tip = tip;
    if (keys) b.dataset.keys = keys;
    if (glyph) b.append(glyph);
    return b;
  }
  // The app's own icons.
  const ICON = {
    sidebar: ['M4 2.5h8A2.5 2.5 0 0 1 14.5 5v6a2.5 2.5 0 0 1-2.5 2.5H4A2.5 2.5 0 0 1 1.500 11V5A2.5 2.5 0 0 1 4 2.5zM6 2.5v11', 16],
    storm: 'M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719',
    fresh: 'M11.5 4.25H9.5a5.25 5.25 0 0 0-5.25 5.25v5a5.25 5.25 0 0 0 5.25 5.25h5a5.25 5.25 0 0 0 5.25-5.25v-2M17.6 3.850a1.8 1.8 0 0 1 2.55 2.55l-7.3 7.3a2 2 0 0 1-.93.52l-2.42.58.58-2.42a2 2 0 0 1 .52-.93z',
    plus: ['M8 3v10M3 8h10', 16],
    tabClose: ['M4.5 4.5l7 7M11.5 4.5l-7 7', 16],
    copy: 'M11.5 8h7a3.5 3.5 0 0 1 3.5 3.5v7a3.5 3.5 0 0 1-3.5 3.5h-7A3.5 3.5 0 0 1 8 18.5v-7A3.5 3.5 0 0 1 11.5 8zM4.5 16A2.5 2.5 0 0 1 2 13.500V5.5A3.5 3.5 0 0 1 5.5 2h8A2.5 2.5 0 0 1 16 4.500',
    check: 'M20 6 9 17l-5-5',
    ask: 'M13 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5zM15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5z',
    reset: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5',
    close: ['M4 4l8 8M12 4l-8 8', 16],
    settings: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM16 12a4 4 0 1 1 -8 0 4 4 0 0 1 8 0z',
  };
  const glyph = (name, size = 14) => (Array.isArray(ICON[name]) ? icon(ICON[name][0], size, ICON[name][1]) : icon(ICON[name], size));
  const WORD = () => {
    const w = el('span', 'word');
    w.setAttribute('aria-hidden', 'true');
    for (const c of 'storm') w.append(el('i', '', c));
    return w;
  };

  // ---------- the window ----------
  const app = el('div', 'app wall');
  const top = el('div', 'app-top');
  const sidebarBtn = button('app-icon app-side-toggle', 'Show or hide the sidebar', glyph('sidebar', 16), 'Toggle sidebar');
  const tabsEl = el('div', 'app-tabs');
  const plusBtn = button('app-icon', 'Open a storm in a new tab', glyph('plus', 14), 'New tab');
  top.append(sidebarBtn, tabsEl, plusBtn);

  const side = el('div', 'app-side');
  const head = el('div', 'app-side-head');
  const newBtn = button('app-icon', 'New storm', icon(ICON.fresh, 17));
  head.append(WORD(), newBtn);
  const listEl = el('div', 'app-list');
  // Settings, at the foot of the sidebar as in the app. There are no settings here, so it does nothing.
  const foot = el('div', 'app-side-foot');
  const settingsBtn = button('app-side-link', 'Settings', icon(ICON.settings, 16));
  settingsBtn.removeAttribute('data-tip'); // the app shows no tooltip on it: the label is right there
  settingsBtn.append(el('span', '', 'Settings'), el('span', 'keys', '⌘P'));
  foot.append(settingsBtn);
  side.append(head, listEl, foot);

  const pane = el('div', 'app-pane');
  const status = el('span', 'app-status');
  const scroll = el('div', 'app-scroll');
  const editorEl = el('div', 'app-editor');
  const tweetsEl = el('div', 'app-tweets');
  const hints = el('div', 'app-hints');
  const pill = (label, keys, act) => {
    const b = el('button', 'pill', label + ' ');
    b.type = 'button';
    b.dataset.act = act;
    b.append(el('span', 'keys', keys));
    return b;
  };
  const newTweetPill = pill('New tweet', '⌘↵', 'new-tweet');
  const mergePill = pill('Merge up', '⌘⌫', 'merge-up');
  hints.append(newTweetPill, mergePill);
  editorEl.append(tweetsEl, hints);
  scroll.append(editorEl);
  pane.append(el('div', 'app-wall'), el('div', 'app-shade'), status, scroll);

  // The + lists the storms that aren't open yet; picking one opens it in a new tab.
  const picker = el('div', 'app-picker');
  picker.hidden = true;

  // A label and its shortcut in a pill under the control, after a short pause, as in the app.
  const tip = el('div', 'pill app-tip');
  app.append(top, side, pane, picker, tip);
  let tipFor = null;
  let tipTimer = 0;
  function hideTip() {
    clearTimeout(tipTimer);
    tipFor = null;
    tip.classList.remove('on');
  }
  function showTip(target) {
    if (!target.isConnected) return;
    tip.replaceChildren(el('span', '', target.dataset.tip));
    if (target.dataset.keys) tip.append(el('span', 'keys', target.dataset.keys));
    tip.classList.add('on');
    const r = target.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const below = r.bottom + 8;
    tip.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8)) + 'px';
    tip.style.top = (below + h > window.innerHeight - 8 ? r.top - h - 8 : below) + 'px';
  }
  app.addEventListener('mouseover', (e) => {
    let target = e.target.closest('[data-tip]');
    if (target && target.disabled) target = null; // nothing to explain on a control that is off
    if (target && !picker.hidden) target = null; // the picker is open: a tooltip would sit across it
    if (target === tipFor) return;
    hideTip();
    if (!target) return;
    tipFor = target;
    tipTimer = setTimeout(() => showTip(target), 350);
  });
  app.addEventListener('mouseleave', hideTip);
  document.addEventListener('mousedown', hideTip);
  window.addEventListener('scroll', hideTip, { passive: true });

  // ---------- drawing ----------
  /** The top bar's tabs: each storm open, the current one outlined. */
  function drawTabs() {
    tabsEl.replaceChildren(
      ...tabs.map((s, i) => {
        const blank = isBlank(s);
        const tab = el('div', 'app-tab' + (i === active ? ' current' : '') + (blank ? ' blank' : ''));
        const close = button('app-tab-close', 'Close tab', glyph('tabClose', 12));
        tab.append(blank ? icon(ICON.fresh, 14) : icon(ICON.storm, 14), el('span', 'app-tab-title', titleOf(s)), close);
        tab.addEventListener('click', (e) => (close.contains(e.target) ? closeTab(i) : show(i)));
        return tab;
      })
    );
    plusBtn.disabled = !storms.some((s) => !tabs.includes(s));
  }

  function drawList() {
    listEl.replaceChildren(
      ...storms.map((s) => {
        const row = el('button', 'app-storm' + (s === cur ? ' current' : ''));
        row.type = 'button';
        row.append(el('span', 'app-storm-title', titleOf(s)), el('span', 'app-storm-meta', `${plural(count(s))} · ${s.when}`));
        row.addEventListener('click', () => openStorm(s));
        return row;
      })
    );
  }

  /** What changes as you type: the wallpaper, the names, the status, which buttons can act. */
  function sync() {
    const blank = isBlank(cur);
    app.classList.toggle('wall', blank);
    editorEl.classList.toggle('blank', blank);
    status.textContent = blank ? '' : `${plural(count(cur))} · saved`;
    newTweetPill.classList.toggle('off', blank);
    mergePill.classList.toggle('off', blank || at === 0);
    drawTabs();
    drawList();
  }

  /** One tweet's words behind its field, with whatever runs past the limit marked. */
  function paint(row, i) {
    const text = cur.tweets[i];
    const { count: n, overAt } = measure(text);
    const back = row.querySelector('.backdrop');
    back.replaceChildren(overAt < 0 ? text : text.slice(0, overAt));
    if (overAt >= 0) back.append(el('mark', '', text.slice(overAt)));
    back.append(' '); // keeps a last empty line as tall as it is in the field
    row.querySelector('.gutter').textContent = text.trim() ? n : '';
    row.querySelector('.copy').hidden = !text.trim();
    row.classList.toggle('over', overAt >= 0);
  }

  function buildTweet(i) {
    const row = el('div', 'tweet');
    const field = el('div', 'field');
    const ta = el('textarea', 'text');
    ta.rows = 1;
    ta.spellcheck = false;
    ta.value = cur.tweets[i];
    ta.placeholder = i === 0 ? 'Start typing…' : 'Keep writing…';
    ta.setAttribute('aria-label', `Tweet ${i + 1}`);
    field.append(el('div', 'text backdrop'), ta);

    const copy = button('tool copy', 'Copy tweet', glyph('copy'));
    copy.addEventListener('mousedown', (e) => e.preventDefault());
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(cur.tweets[i].trim());
      } catch {
        return;
      }
      copy.replaceChildren(glyph('check'));
      setTimeout(() => copy.replaceChildren(glyph('copy')), 1200);
    });
    const ask = button('tool ask', 'Ask about this tweet', glyph('ask'), 'Ask', '⌘K');
    ask.classList.toggle('kept', Boolean(cur.notes.get(i)?.saved));
    ask.addEventListener('mousedown', (e) => e.preventDefault()); // the caret stays where it is
    ask.addEventListener('click', () => openAsk(i));
    const tools = el('div', 'tools');
    tools.append(copy, ask);

    row.append(el('span', 'num'), field, tools, el('span', 'gutter'));
    const note = cur.notes.get(i);
    if (note?.open) row.append(buildNote(i, note));

    ta.addEventListener('focus', () => {
      at = i;
      sync();
    });
    ta.addEventListener('input', () => {
      const wasBlank = isBlank(cur);
      cur.tweets[i] = ta.value;
      if (wasBlank && !isBlank(cur) && !storms.includes(cur)) storms.unshift(cur); // it is a storm now
      paint(row, i);
      sync();
    });
    ta.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        split(i, ta.selectionStart);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        if (e.shiftKey) remove(i);
        else merge(i);
      } else if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openAsk(i);
      }
    });
    paint(row, i);
    return row;
  }

  /** Redraws the storm and puts the caret in tweet `focus` at `caret` (when given). */
  function draw(focus, caret) {
    tweetsEl.replaceChildren(...cur.tweets.map((_, i) => buildTweet(i)));
    if (focus != null) at = focus;
    sync();
    if (focus == null) return;
    const ta = tweetsEl.children[focus].querySelector('textarea');
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(caret, caret);
  }

  // ---------- tabs ----------
  function show(i) {
    for (const note of cur.notes.values()) {
      clearTimeout(note.timer);
      if (note.phase === 'waiting') note.open = false; // a question left waiting is called off
    }
    for (const [k, note] of cur.notes) if (!note.saved && !note.open) cur.notes.delete(k);
    active = i;
    cur = tabs[i];
    at = 0;
    scroll.scrollTop = 0;
    closePicker();
    draw();
  }

  /** A storm from the sidebar: its own tab if it has one, or it takes the place of this one. */
  function openStorm(s) {
    const open = tabs.indexOf(s);
    if (open >= 0) return show(open);
    tabs[active] = s;
    show(active);
  }

  function newStorm() {
    if (isBlank(cur)) return draw(0, 0);
    const blank = tabs.findIndex(isBlank); // a blank storm already open is the new storm
    if (blank < 0) tabs.push(blankStorm());
    show(blank < 0 ? tabs.length - 1 : blank);
    draw(0, 0);
  }

  function closeTab(i) {
    if (tabs.length === 1) {
      if (isBlank(tabs[0])) return; // the app would close its window here
      tabs[0] = blankStorm();
      return show(0);
    }
    tabs.splice(i, 1);
    if (i < active) active--;
    else if (active >= tabs.length) active = tabs.length - 1;
    show(active);
  }

  function openPicker() {
    const closed = storms.filter((s) => !tabs.includes(s));
    if (!closed.length) return;
    picker.replaceChildren(
      el('div', 'app-picker-label', 'Open in a new tab'),
      ...closed.map((s) => {
        const row = el('button', 'app-picker-row');
        row.type = 'button';
        row.append(el('span', 'app-picker-title', titleOf(s)), el('span', 'app-picker-meta', `${plural(count(s))} · ${s.when}`));
        row.addEventListener('click', () => {
          tabs.push(s);
          show(tabs.length - 1);
        });
        return row;
      })
    );
    picker.hidden = false;
    // Below the +, kept inside the window.
    const box = app.getBoundingClientRect();
    const plus = plusBtn.getBoundingClientRect();
    const width = Math.min(300, box.width - 16);
    picker.style.width = width + 'px';
    picker.style.left = Math.max(8, Math.min(plus.left - box.left, box.width - width - 8)) + 'px';
    picker.style.top = plus.bottom - box.top + 6 + 'px';
  }
  function closePicker() {
    picker.hidden = true;
  }

  // ---------- writing ----------
  /** Notes belong to tweets by number. A split at i moves the notes after i down one; a merge or
      deletion of tweet i drops its note and moves the ones after it up one. */
  function splitNotes(i) {
    cur.notes = new Map([...cur.notes].map(([k, note]) => [k > i ? k + 1 : k, note]));
  }
  function joinNotes(i) {
    const kept = [];
    for (const [k, note] of cur.notes) {
      if (k === i) clearTimeout(note.timer);
      else kept.push([k > i ? k - 1 : k, note]);
    }
    cur.notes = new Map(kept);
  }

  /** ⌘↵: a new tweet starts where the caret is, opening up gently, its rail drawing in. */
  function split(i, caret) {
    const text = cur.tweets[i];
    cur.tweets.splice(i, 1, text.slice(0, caret).trimEnd(), text.slice(caret).trimStart());
    splitNotes(i);
    draw(i + 1, 0);
    unfold(tweetsEl.children[i + 1]);
    tweetsEl.children[i].classList.add('draw-rail');
  }

  /** The app's own: the new tweet's space grows first, then the tweet fades in as it settles. */
  function unfold(row) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const style = getComputedStyle(row);
    const full = { height: row.offsetHeight + 'px', paddingTop: style.paddingTop, paddingBottom: style.paddingBottom };
    row.style.overflow = 'hidden';
    const motion = row.animate(
      [{ height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0 }, { opacity: 0, offset: 0.3 }, { ...full, opacity: 1 }],
      { duration: 680, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }
    );
    motion.onfinish = motion.oncancel = () => (row.style.overflow = '');
  }

  /** ⌘⌫: a tweet joins the one above it. */
  function merge(i) {
    if (i === 0) return;
    const a = cur.tweets[i - 1];
    const b = cur.tweets[i];
    const joiner = a && b && !/\s$/.test(a) && !/^\s/.test(b) ? ' ' : '';
    cur.tweets.splice(i - 1, 2, a + joiner + b);
    joinNotes(i);
    draw(i - 1, a.length);
  }

  /** ⇧⌘⌫: the tweet goes. The last one left is emptied instead. */
  function remove(i) {
    if (cur.tweets.length === 1) {
      cur.tweets[0] = '';
      joinNotes(0);
      return draw(0, 0);
    }
    cur.tweets.splice(i, 1);
    joinNotes(i);
    const next = Math.min(i, cur.tweets.length - 1);
    draw(next, cur.tweets[next].length);
  }

  // ---------- asking ----------
  /** Opens tweet i's note on its kept reply, or on the questions; pressed again, closes it. */
  function openAsk(i) {
    if (isBlank(cur)) return;
    const note = cur.notes.get(i) ?? { open: false, phase: 'asking', saved: null };
    cur.notes.set(i, note);
    if (note.open) return closeNote(i);
    note.open = true;
    note.phase = note.saved ? 'done' : 'asking';
    drawNote(i, true);
  }

  function closeNote(i, toTweet = false) {
    const note = cur.notes.get(i);
    if (!note) return;
    clearTimeout(note.timer);
    note.open = false;
    if (!note.saved) cur.notes.delete(i);
    drawNote(i);
    if (toTweet) tweetsEl.children[i]?.querySelector('textarea').focus({ preventScroll: true });
  }

  function send(i, question) {
    const note = cur.notes.get(i);
    Object.assign(note, { phase: 'waiting', question });
    drawNote(i, true);
    note.timer = setTimeout(() => {
      const k = [...cur.notes].find(([, n]) => n === note)?.[0]; // where its tweet now stands
      if (k == null) return;
      Object.assign(note, { phase: 'done', saved: { question, ...replyFor(cur, k, question) } });
      drawNote(k, true);
    }, 1500);
  }

  /** Redraws tweet i's note in place, and its Ask button, which stays in view while a reply is kept. */
  function drawNote(i, fresh = false) {
    const row = tweetsEl.children[i];
    if (!row) return;
    row.querySelector(':scope > .note')?.remove();
    const note = cur.notes.get(i);
    row.querySelector('.ask').classList.toggle('kept', Boolean(note?.saved));
    if (!note?.open) return;
    const box = buildNote(i, note);
    if (fresh) box.classList.add('fresh');
    row.append(box);
    if (note.phase === 'asking') box.querySelector('input').focus({ preventScroll: true });
    // Keep the note in sight inside the window's own scroll, without moving the page.
    const pad = 16;
    const view = scroll.getBoundingClientRect();
    const r = box.getBoundingClientRect();
    if (r.bottom > view.bottom - pad) scroll.scrollTop += Math.min(r.bottom - view.bottom + pad, r.top - view.top - pad);
  }

  const noteButton = (name, label, run) => {
    const b = button('note-btn', label, glyph(name, 14));
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', run);
    return b;
  };

  /** The reply as it is read: paragraphs, and any wording offered ("> …") set apart with a copy
      button. Words in double quotes are the reply pointing at the writer's own, drawn brighter. */
  function replyBlocks(text) {
    const blocks = [];
    let open = null;
    for (const line of text.split('\n').map((l) => l.trim())) {
      const offered = line.startsWith('>');
      const words = offered ? line.replace(/^>\s*/, '') : line;
      if (!words) open = null;
      else if (open && open.offered === offered) open.lines.push(words);
      else blocks.push((open = { offered, lines: [words] }));
    }
    return blocks.map(({ offered, lines }) => {
      if (!offered) {
        const p = el('p');
        p.append(...lines.join('\n').split(/("[^"\n]{2,}")/).map((part, k) => (k % 2 ? el('em', '', part) : part)));
        return p;
      }
      const wording = lines.join('\n');
      const block = el('div', 'offered');
      const copy = button('note-btn', 'Copy this wording', glyph('copy'), 'Copy');
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(wording);
        } catch {
          return;
        }
        copy.replaceChildren(glyph('check'));
        setTimeout(() => copy.replaceChildren(glyph('copy')), 1200);
      });
      block.append(el('div', '', wording), copy);
      return block;
    });
  }

  function buildNote(i, note) {
    const box = el('div', 'note is-' + note.phase);
    if (note.phase === 'asking') {
      const ready = el('div', 'ask-ready');
      ready.append(
        ...READY.map((q) => {
          const chip = el('button', 'ask-chip', q);
          chip.type = 'button';
          chip.addEventListener('click', () => send(i, q));
          return chip;
        })
      );
      const acts = el('div', 'note-acts');
      acts.append(noteButton('close', 'Close', () => closeNote(i, true)));
      const topRow = el('div', 'ask-top');
      topRow.append(ready, acts);
      const field = el('label', 'ask-field');
      const input = el('input', 'ask-input');
      input.type = 'text';
      input.spellcheck = false;
      input.placeholder = 'Ask about this tweet';
      input.setAttribute('aria-label', 'Ask about this tweet');
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim()) send(i, input.value.trim());
        else if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) {
          e.preventDefault();
          closeNote(i, true);
        }
      });
      field.append(input, el('span', 'keys', '↵'));
      box.append(topRow, field);
      return box;
    }
    const done = note.phase === 'done';
    const acts = el('div', 'note-acts');
    if (done)
      acts.append(
        noteButton('reset', 'Reset', () => {
          note.saved = null;
          note.phase = 'asking';
          drawNote(i, true);
        })
      );
    acts.append(noteButton('close', done ? 'Close' : 'Cancel', () => closeNote(i, true)));
    const headRow = el('div', 'note-head');
    headRow.append(el('span', 'note-ask', done ? note.saved.question : note.question), el('span', 'note-model', done ? note.saved.model : ''), acts);
    box.append(headRow);
    if (!done) {
      const line = el('div', 'note-line');
      const dots = el('span', 'waiting');
      dots.setAttribute('aria-hidden', 'true');
      for (let k = 0; k < 9; k++) dots.append(el('i'));
      line.append(dots, el('span', '', 'Waiting for a reply…'));
      box.append(line);
    } else {
      const reply = el('div', 'note-reply');
      reply.append(...replyBlocks(note.saved.reply));
      box.append(reply);
    }
    return box;
  }

  // ---------- what the chrome does ----------
  sidebarBtn.addEventListener('click', () => app.classList.toggle('collapsed'));
  newBtn.addEventListener('click', newStorm);
  plusBtn.addEventListener('click', () => (picker.hidden ? openPicker() : closePicker()));
  document.addEventListener('mousedown', (e) => {
    if (!picker.hidden && !picker.contains(e.target) && !plusBtn.contains(e.target)) closePicker();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !picker.hidden) closePicker();
  });
  newTweetPill.addEventListener('click', () => {
    if (isBlank(cur)) return;
    const ta = tweetsEl.children[at]?.querySelector('textarea');
    split(at, ta ? ta.selectionStart : cur.tweets[at].length);
  });
  mergePill.addEventListener('click', () => !isBlank(cur) && merge(at));
  // A click on the empty part of the page puts the caret at the end of the storm.
  scroll.addEventListener('mousedown', (e) => {
    if (e.target.closest('textarea, button, input, .note')) return;
    e.preventDefault();
    const last = cur.tweets.length - 1;
    const ta = tweetsEl.children[last].querySelector('textarea');
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });

  // ---------- in it goes ----------
  figure.className = 'demo';
  figure.querySelector('picture, img').replaceWith(app);
  figure.querySelector('figcaption').textContent = 'Try it.';
  draw();
})();
