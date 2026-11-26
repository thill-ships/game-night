// Routing: hub landing (/), host (/?host), player (/?g=ABCD).
import { params, cleanCode, cleanName, isLocalMode, urlWith } from './proto.js';
import { h, clear } from './ui/dom.js';
import { registerServiceWorker } from './update.js';

registerServiceWorker();

const root = document.getElementById('app');

if (params.has('host')) {
  import('./room-host.js').then((m) => m.startHost(root)).catch(fatal);
} else if (params.get('g')) {
  const code = cleanCode(params.get('g'));
  if (code.length === 4) import('./room-player.js').then((m) => m.startPlayer(root, code)).catch(fatal);
  else landing('That room code looks wrong.');
} else {
  landing();
}

function landing(err) {
  document.body.className = 'landing';
  const store = isLocalMode() ? sessionStorage : localStorage;
  const code = h('input', { type: 'text', maxlength: 4, placeholder: 'ABCD', autocapitalize: 'characters', autocomplete: 'off', spellcheck: false, 'aria-label': 'Room code', class: 'code-input' });
  const name = h('input', { type: 'text', maxlength: 18, placeholder: 'Your name', value: store.getItem('gn.name') || '', autocomplete: 'nickname', 'aria-label': 'Your name' });
  code.addEventListener('input', () => { code.value = cleanCode(code.value); });
  const msg = h('p.error', null, err || '');
  const join = (e) => {
    e.preventDefault();
    const c = cleanCode(code.value), n = cleanName(name.value);
    if (c.length !== 4) { msg.textContent = 'Enter the 4-letter code from the TV.'; code.focus(); return; }
    if (!n) { msg.textContent = 'Enter your name.'; name.focus(); return; }
    store.setItem('gn.name', n);
    store.setItem('gn.room', c);
    location.href = urlWith('g=' + c);
  };
  clear(root).append(h('div.landing-wrap', null,
    h('div.brand.huge', null, h('span.brand-mark', null, '♠'), ' Game Night'),
    h('p.tagline', null, 'One screen for the table. Everyone plays from their phone.'),
    h('div.landing-cards', null,
      h('form.card.join-form', { onsubmit: join },
        h('h2', null, 'Join a room'),
        code, name, msg,
        h('button.btn.primary.big', { type: 'submit' }, 'Join')),
      h('div.card', null,
        h('h2', null, 'Host on this screen'),
        h('p.hint', null, 'Use the computer hooked up to the TV. Players scan a QR code to join.'),
        h('a.btn.secondary.big', { href: urlWith('host') }, 'Host a game night'))),
    isLocalMode() ? h('p.hint.center', null, 'Local test mode: open the host and players in tabs of this same browser.') : null));
}

function fatal(e) {
  console.error(e);
  clear(root).append(h('div.phone-center', null, h('h2', null, 'Something went wrong loading Game Night.'), h('p.hint', null, String(e?.message || e)),
    h('button.btn.primary', { onclick: () => location.reload() }, 'Reload')));
}
