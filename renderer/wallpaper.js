// The wallpaper behind a new storm: the chosen image, drawn with one of three effects.
//
// Dither sends it through Paper Shaders' image dithering shader (Apache-2.0), keeping the
// image's own colours. Brightness is cut into a few steps and a fine Bayer grid of dots, one
// step lighter or darker than their surroundings, carries the tones in between. The image
// drifts a hair under the fixed dot grid, so the dots along soft edges come and go.
//
// Blur is the image itself, a little out of focus, drifting just as slowly. Grain is the image
// in focus under a still layer of film grain, so the grain plays across it as it drifts. The
// softening, the drift and the grain's strength are in style.css, under .wall-fx.
//
// It can be drawn on more than one surface at once: the pane behind a new storm, and the
// preview in Settings.
import { ShaderMount } from '../node_modules/@paper-design/shaders/dist/shader-mount.js';
import { imageDitheringFragmentShader, DitheringTypes } from '../node_modules/@paper-design/shaders/dist/shaders/image-dithering.js';

const DOT_SIZE = 2; // px per dither cell
const STEPS = 7; // brightness steps; more steps means fainter dots
const ZOOM = 1.06; // slack around the image so the drift never shows its edge
const DRIFT = 0.012; // how far the image wanders, as a fraction of its size

// The library adds its own <style> tag unless one is already present, which the page's content
// policy would block. style.css carries the same layout rules, so an empty tag stands in.
if (!document.querySelector('style[data-paper-shader]')) {
  const marker = document.createElement('style');
  marker.setAttribute('data-paper-shader', '');
  document.head.append(marker);
}

/** @type {{el: HTMLElement, mount: ShaderMount | null, layer: HTMLElement | null, on: boolean}[]} */
const surfaces = [];
let image = null;
let url = null;
let raf = 0;
/** @type {'dither' | 'blur' | 'grain'} */
let effect = 'dither';

// One square of film grain, made once: grey specks scattered around mid-grey, which lighten
// and darken what is under them when laid over it.
const GRAIN_SIZE = 256;
let grainTile = null;

function grain() {
  grainTile ??= new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = GRAIN_SIZE;
    const ctx = canvas.getContext('2d');
    const pixels = ctx.createImageData(GRAIN_SIZE, GRAIN_SIZE);
    for (let i = 0; i < pixels.data.length; i += 4) {
      // The sum of three random numbers is close enough to a bell curve: mostly mid-grey.
      const v = 128 + (Math.random() + Math.random() + Math.random() - 1.5) * 115;
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = v;
      pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    canvas.toBlob((blob) => resolve(URL.createObjectURL(blob)));
  });
  return grainTile;
}

function placement(ms) {
  const t = ms / 1000;
  return {
    u_scale: ZOOM + 0.012 * Math.sin(t * 0.045),
    u_offsetX: DRIFT * Math.sin(t * 0.06),
    u_offsetY: DRIFT * Math.cos(t * 0.041),
  };
}

function tick(ms) {
  raf = 0;
  const live = surfaces.filter((s) => s.on && s.mount);
  if (!image || !live.length) return;
  const place = placement(ms);
  for (const s of live) s.mount.setUniforms(place);
  raf = requestAnimationFrame(tick);
}

/** Takes down whatever a surface is drawing, so the other effect can take its place. */
function clear(s) {
  s.mount?.dispose();
  s.mount = null;
  s.layer?.remove();
  s.layer = null;
}

/** The image as a plain layer, for the effects that are not drawn by the shader. */
function buildLayer() {
  const layer = document.createElement('div');
  layer.className = `wall-fx wall-${effect}`;
  const picture = document.createElement('div');
  picture.className = 'wall-image';
  picture.style.backgroundImage = `url("${url}")`;
  layer.append(picture);
  if (effect === 'grain') {
    const noise = document.createElement('div');
    noise.className = 'wall-noise';
    grain().then((tile) => {
      noise.style.backgroundImage = `url("${tile}")`;
    });
    layer.append(noise);
  }
  return layer;
}

/** Starts drawing on any surface that has just come on, and keeps the drift running. */
function sync() {
  if (!image) return;
  const unused = [0, 0, 0, 0];
  for (const s of surfaces) {
    if (!s.on) continue;
    if (effect !== 'dither') {
      if (s.layer) continue;
      s.layer = buildLayer();
      s.el.append(s.layer);
      continue;
    }
    if (s.mount) continue;
    s.mount = new ShaderMount(
      s.el,
      imageDitheringFragmentShader,
      {
        u_image: image,
        u_originalColors: true,
        u_inverted: false,
        u_type: DitheringTypes['4x4'],
        u_pxSize: DOT_SIZE,
        u_colorSteps: STEPS,
        u_colorFront: unused,
        u_colorBack: unused,
        u_colorHighlight: unused,
        u_fit: 2,
        u_rotation: 0,
        u_originX: 0.5,
        u_originY: 0.5,
        ...placement(performance.now()),
      },
      undefined,
      0
    );
  }
  if (!raf && surfaces.some((s) => s.on && s.mount)) raf = requestAnimationFrame(tick);
}

export const Wallpaper = {
  /** Sets the image, or clears it with null bytes. Rejects if the bytes are not a readable image. */
  async load(bytes, mime) {
    let next = null;
    let nextUrl = null;
    if (bytes) {
      nextUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
      next = new Image();
      next.src = nextUrl;
      try {
        await next.decode();
      } catch (err) {
        URL.revokeObjectURL(nextUrl);
        throw err;
      }
    }
    if (url) URL.revokeObjectURL(url);
    image = next;
    url = nextUrl;
    if (image) {
      for (const s of surfaces) {
        s.mount?.setUniforms({ u_image: image });
        const picture = s.layer?.querySelector('.wall-image');
        if (picture) picture.style.backgroundImage = `url("${url}")`;
      }
    }
    sync();
  },

  /** Switches how the image is drawn: 'dither', 'blur' or 'grain'. */
  setEffect(name) {
    const next = name === 'blur' || name === 'grain' ? name : 'dither';
    if (next === effect) return;
    effect = next;
    surfaces.forEach(clear);
    sync();
  },

  /** Registers an element to draw the wallpaper in. Turn it on only while it is on screen. */
  surface(el) {
    const s = { el, mount: null, layer: null, on: false };
    surfaces.push(s);
    return {
      setActive(on) {
        s.on = on;
        sync();
      },
    };
  },
};
