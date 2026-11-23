'use strict';

const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Screenshots sit in a frame of their own, so the window's corners and buttons can be drawn on it.
for (const img of document.querySelectorAll('.shot > img')) {
  const frame = document.createElement('div');
  img.replaceWith(frame);
  frame.append(img);
}

// The word at the top starts calm, then gathers its weight once.
const hero = document.getElementById('hero-word');
if (still) hero.classList.remove('calm');
else (document.fonts?.ready ?? Promise.resolve()).then(() => setTimeout(() => hero.classList.remove('calm'), 500));

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
