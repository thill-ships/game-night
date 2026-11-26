// Bank: push-your-luck dice. Module contract: see README "Adding a game".
import * as rules from './rules.js';
import { tutorial } from './tutorial.js';
import { tv } from './tv.js';
import { phone } from './phone.js';

export default {
  id: 'bank',
  name: 'Bank',
  tagline: 'Push your luck. Bank before the 7.',
  minPlayers: 2,
  maxPlayers: 16,
  estMinutes: [20, 40],
  css: new URL('./bank.css', import.meta.url).href,
  options: [
    { id: 'rounds', label: 'Rounds', type: 'choice', values: [10, 15, 20], default: 20 },
    { id: 'early', label: 'Allow banking in the first 3 rolls', type: 'bool', default: true },
    { id: 'phoneRoll', label: 'Players roll from their phones', type: 'bool', default: true },
  ],
  tutorial,

  setup: rules.setup,
  validate: rules.validate,
  apply: rules.apply,
  publicView: (s) => ({ ...s, phaseText: rules.phaseLabel(s) }), // Bank has no secrets
  privateView: null,
  activePids: rules.activePids,
  isOver: rules.isOver,
  results: rules.results,
  undoable: true,

  hostActions(pub) {
    if (pub.phase === 'roundEnd') {
      return [{ label: pub.round >= pub.rounds ? 'See results' : 'Next round', intent: { type: 'next' }, primary: true }];
    }
    if (pub.phase !== 'roll') return [];
    const reason = pub.rolling ? 'Rolling…' : !pub.roller ? 'Nobody to roll' : null;
    return [
      { label: pub.phoneRoll ? 'Roll for them' : '🎲 Roll', intent: { type: 'roll' }, primary: !pub.phoneRoll, reason },
      { label: 'Skip turn', intent: { type: 'skip' }, reason },
    ];
  },

  tv,
  phone,
};
