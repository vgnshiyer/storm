'use strict';

// Colour themes. Every theme comes as a dark and a light palette, and the Mode setting
// (system, light or dark) picks between them. A palette names the window frame (top bar and
// sidebar), the writing pane, three text strengths, an accent, and a warning colour;
// style.css derives the rest. X follows the look of the site the storms are written for:
// black or white, with its blue. Catppuccin, Gruvbox, Everforest and One are open community
// palettes. Their frame, pane and accent colours here are matched to the reference app the
// look was borrowed from (sampled from its theme picker, light and dark); the text colours
// are each palette's own. A palette may also set `outline`: how strong the app's one outline
// colour is, as a percentage of the frame's text colour (7 when it says nothing).
const THEMES = [
  {
    id: 'graphite', // kept from when this theme was called Graphite, so a saved choice still matches
    name: 'Storm',
    dark: { frame: '#000000', frameText: '#ffffff', bg: '#161616', text: '#ececea', soft: '#b4b2a9', muted: '#85847f', accent: '#6b8afd', danger: '#f28b82' },
    light: { frame: '#ecebe7', frameText: '#1a1a1a', bg: '#ffffff', text: '#1a1a1a', soft: '#5f5e5a', muted: '#8f8e89', accent: '#3b6fd9', danger: '#b3261e' },
  },
  {
    id: 'oled', // kept from when this theme was called OLED, so a saved choice still matches
    name: 'X',
    // Pane and frame are the same colour here, so the outline alone separates them: it is stronger.
    dark: { outline: 13, frame: '#000000', frameText: '#ffffff', bg: '#000000', text: '#e7e9ea', soft: '#a3a8ac', muted: '#71767b', accent: '#1d9bf0', danger: '#f4212e' },
    light: { outline: 11, frame: '#ffffff', frameText: '#0f1419', bg: '#ffffff', text: '#0f1419', soft: '#3e4a54', muted: '#536471', accent: '#1d9bf0', danger: '#f4212e' },
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin',
    dark: { frame: '#11111b', frameText: '#cdd6f4', bg: '#181825', text: '#cdd6f4', soft: '#bac2de', muted: '#7f849c', accent: '#cba6f7', danger: '#f38ba8' },
    light: { frame: '#eff1f5', frameText: '#4c4f69', bg: '#fafafb', text: '#4c4f69', soft: '#5c5f77', muted: '#8c8fa1', accent: '#8839ef', danger: '#d20f39' },
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    dark: { frame: '#282828', frameText: '#ebdbb2', bg: '#302e2e', text: '#ebdbb2', soft: '#d5c4a1', muted: '#a89984', accent: '#458588', danger: '#fb4934' },
    light: { frame: '#f2e5bc', frameText: '#3c3836', bg: '#fbf6e9', text: '#3c3836', soft: '#504945', muted: '#7c6f64', accent: '#458588', danger: '#9d0006' },
  },
  {
    id: 'everforest',
    name: 'Everforest',
    dark: { frame: '#252c30', frameText: '#d3c6aa', bg: '#2e3538', text: '#d3c6aa', soft: '#9da9a0', muted: '#859289', accent: '#a7c080', danger: '#e67e80' },
    light: { frame: '#f4f0d9', frameText: '#5c6a72', bg: '#fbfaf2', text: '#5c6a72', soft: '#768479', muted: '#939f91', accent: '#8da101', danger: '#f85552' },
  },
  {
    id: 'one-dark',
    name: 'One',
    dark: { frame: '#21252b', frameText: '#d7dae0', bg: '#2a2e34', text: '#d7dae0', soft: '#abb2bf', muted: '#7f848e', accent: '#70757f', danger: '#e06c75' },
    light: { frame: '#eaeaeb', frameText: '#383a42', bg: '#f8f8f8', text: '#383a42', soft: '#696c77', muted: '#a0a1a7', accent: '#5871ef', danger: '#e45649' },
  },
];

const MODES = ['system', 'light', 'dark'];
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

// "Paper" used to be a theme of its own; it is now the light variant of Storm (id 'graphite').
if (localStorage.getItem('theme') === 'paper') {
  localStorage.setItem('theme', 'graphite');
  if (!localStorage.getItem('mode')) localStorage.setItem('mode', 'light');
}

function currentThemeId() {
  const saved = localStorage.getItem('theme');
  return THEMES.some((t) => t.id === saved) ? saved : THEMES[0].id;
}

function currentMode() {
  const saved = localStorage.getItem('mode');
  return MODES.includes(saved) ? saved : 'system';
}

/** 'light' or 'dark': what a mode comes to right now, following the Mac when it is 'system'. */
function resolveMode(mode = currentMode()) {
  if (mode !== 'system') return mode;
  return systemDark.matches ? 'dark' : 'light';
}

/** A theme's colours in the given mode ('light' or 'dark'; the current one by default). */
function paletteOf(id, mode = resolveMode()) {
  return (THEMES.find((t) => t.id === id) ?? THEMES[0])[mode];
}

function applyTheme(id = currentThemeId()) {
  const mode = resolveMode();
  const p = paletteOf(id, mode);
  const root = document.documentElement.style;
  root.setProperty('--frame', p.frame);
  root.setProperty('--frame-text', p.frameText);
  root.setProperty('--bg', p.bg);
  root.setProperty('--text', p.text);
  root.setProperty('--soft', p.soft);
  root.setProperty('--muted', p.muted);
  root.setProperty('--accent', p.accent);
  root.setProperty('--danger', p.danger);
  root.setProperty('--outline-strength', (p.outline ?? 7) + '%');
  root.setProperty('color-scheme', mode);
  localStorage.setItem('theme', THEMES.some((t) => t.id === id) ? id : THEMES[0].id);
}

function setMode(mode) {
  localStorage.setItem('mode', MODES.includes(mode) ? mode : 'system');
  applyTheme();
}

// Follow the Mac when it switches between light and dark.
systemDark.addEventListener('change', () => {
  if (currentMode() !== 'system') return;
  applyTheme();
  document.dispatchEvent(new Event('appearancechange'));
});

applyTheme();
