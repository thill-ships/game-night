// Eight How-to-play slides. visualHtml is static, game-authored markup.
const d = (n) => `<span class="tut-die" data-v="${n}">${['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][n]}</span>`;

export const tutorial = [
  { title: 'Welcome to Bank', body: 'A push-your-luck dice game for the whole table. Everyone shares one pot, called the Bank. The trick is knowing when to take it.', visualHtml: `<div class="tut-big">🏦</div>` },
  { title: 'The Bank grows', body: 'Each round the Bank starts at 0. Players take turns rolling two dice, and each roll adds the total to the Bank.', visualHtml: `<div class="tut-row">${d(4)}${d(5)}<b>+9</b></div>` },
  { title: 'The first 3 rolls are safe', body: 'In rolls 1 to 3, a 7 adds 70 to the Bank! Doubles just count their face value.', visualHtml: `<div class="tut-row">${d(3)}${d(4)}<b class="gold">+70</b></div>` },
  { title: 'From roll 4, doubles double', body: 'From the fourth roll on, doubles double the whole Bank. 150 becomes 300.', visualHtml: `<div class="tut-row">${d(5)}${d(5)}<b class="gold">×2</b></div>` },
  { title: '…and a 7 busts', body: 'From roll 4 on, a 7 ends the round. Anyone who has not banked gets nothing this round.', visualHtml: `<div class="tut-row">${d(6)}${d(1)}<b class="red">BUST</b></div>` },
  { title: 'BANK it!', body: 'Any time the Bank is above 0 and the dice are not rolling, tap BANK on your phone. You add the Bank to your score and sit out the rest of the round. The Bank keeps growing for everyone else.', visualHtml: `<div class="tut-bank">BANK</div>` },
  { title: 'Taking turns', body: 'Rolls go around the table in seat order. Players who banked are skipped. The round ends on a bust or when everyone has banked. The next round starts with the player after the last roller.', visualHtml: `<div class="tut-big">🔄</div>` },
  { title: 'Winning', body: 'After the last round, the highest score wins. Bank early and you are safe. Wait and you might win big… or bust.', visualHtml: `<div class="tut-big">🏆</div>` },
];
