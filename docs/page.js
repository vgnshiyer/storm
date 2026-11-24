'use strict';

const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Screenshots sit in a frame of their own, so the window's corners and buttons can be drawn on it.
// A screenshot that has a light version comes as a <picture>, and the frame goes round that.
for (const img of document.querySelectorAll('.shot > img, .shot > picture')) {
  const frame = document.createElement('div');
  img.replaceWith(frame);
  frame.append(img);
}

// The word at the top waits calm, then rises and gathers its weight once.
const hero = document.getElementById('hero-word');
if (still) hero.classList.remove('calm');
else (document.fonts?.ready ?? Promise.resolve()).then(() => setTimeout(() => hero.classList.remove('calm'), 500));

// The themes carousel: the track scrolls a window at a time; the bar names the one showing,
// counts it, and steps back or on. Swiping and the arrow keys work on the track itself.
for (const carousel of document.querySelectorAll('.carousel')) {
  const track = carousel.querySelector('.track');
  const slides = [...track.children];
  const name = carousel.querySelector('.carousel-name');
  const count = carousel.querySelector('.carousel-count');
  const [prev, next] = carousel.querySelectorAll('.carousel-btn');
  const step = () => slides[1].offsetLeft - slides[0].offsetLeft;
  const at = () => Math.min(slides.length - 1, Math.max(0, Math.round(track.scrollLeft / step())));
  let cur = 0;
  let moving = false; // a step is gliding to its slide: the bar already names where it is going
  let settle = 0;
  let since = 0;
  // Once the track is still, the bar matches what shows. While a step is still on its way, it waits
  // (for a moment at most: a glide that never arrives gives the bar back to the track).
  function check() {
    if (moving && at() !== cur && Date.now() - since < 1500) {
      settle = setTimeout(check, 150);
      return;
    }
    moving = false;
    show(at());
  }
  function show(i) {
    cur = i;
    name.textContent = slides[i].dataset.name;
    count.textContent = `${i + 1} / ${slides.length}`;
    prev.disabled = i === 0;
    next.disabled = i === slides.length - 1;
  }
  function go(i) {
    i = Math.max(0, Math.min(slides.length - 1, i));
    moving = true;
    since = Date.now();
    show(i);
    track.scrollTo({ left: i * step(), behavior: still ? 'instant' : 'smooth' });
    clearTimeout(settle);
    settle = setTimeout(check, 150);
  }
  prev.addEventListener('click', () => go(cur - 1));
  next.addEventListener('click', () => go(cur + 1));
  track.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      go(cur + (e.key === 'ArrowLeft' ? -1 : 1));
    }
  });
  // A swipe names each slide as it passes.
  track.addEventListener(
    'scroll',
    () => {
      if (!moving) show(at());
      clearTimeout(settle);
      settle = setTimeout(check, 150);
    },
    { passive: true }
  );
  show(0);
}

// The index marks the section being read: the last one whose top has passed the upper third.
const links = [...document.querySelectorAll('#index li a')];
const sections = links.map((a) => document.querySelector(a.getAttribute('href')));
function mark() {
  const line = window.innerHeight / 3;
  let current = -1;
  sections.forEach((s, i) => {
    if (s.getBoundingClientRect().top <= line) current = i;
  });
  links.forEach((a, i) => a.setAttribute('aria-current', String(i === current)));
}
window.addEventListener('scroll', mark, { passive: true });
window.addEventListener('resize', mark);
mark();
