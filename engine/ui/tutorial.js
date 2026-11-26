// How-to-play carousel: scroll-snap slides, dots, keyboard arrows.
import { h } from './dom.js';
import { sheet } from './overlay.js';

export function carousel(slides) {
  const track = h('div.carousel-track', { tabindex: '0' },
    slides.map((sl, i) => h('section.slide', { 'aria-label': `Slide ${i + 1} of ${slides.length}` },
      sl.visualHtml ? h('div.slide-visual', { html: sl.visualHtml }) : null, // game-authored static markup
      h('h3', null, sl.title),
      h('p', null, sl.body))));
  const dots = h('div.dots', null, slides.map((_, i) =>
    h('button.dot', { 'aria-label': `Go to slide ${i + 1}`, onclick: () => go(i) })));
  const prev = h('button.icon-btn', { 'aria-label': 'Previous', onclick: () => go(idx - 1) }, '‹');
  const next = h('button.icon-btn', { 'aria-label': 'Next', onclick: () => go(idx + 1) }, '›');
  let idx = 0;
  const mark = () => [...dots.children].forEach((d, i) => d.classList.toggle('on', i === idx));
  const go = (i) => {
    idx = Math.max(0, Math.min(slides.length - 1, i));
    track.scrollTo({ left: track.clientWidth * idx, behavior: 'smooth' });
    mark();
  };
  track.addEventListener('scroll', () => {
    const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    if (i !== idx) { idx = i; mark(); }
  }, { passive: true });
  const el = h('div.carousel', {
    onkeydown: (e) => {
      if (e.key === 'ArrowRight') { go(idx + 1); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { go(idx - 1); e.preventDefault(); }
    },
  }, track, h('div.carousel-nav', null, prev, dots, next));
  mark();
  setTimeout(() => track.focus({ preventScroll: true }), 50);
  return el;
}

export function showTutorial(mod, { cls = '' } = {}) {
  if (!mod || !mod.tutorial || !mod.tutorial.length) return;
  sheet(carousel(mod.tutorial), { title: `How to play ${mod.name}`, cls: 'tutorial ' + cls });
}
