const { io } = require('socket.io-client');
const URL = 'http://localhost:3999';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mk = () => io(URL, { transports: ['websocket'] });
(async () => {
  const host = mk(); let st = null;
  host.on('state', s => st = s);
  await new Promise(r => host.on('connect', r));
  await new Promise(r => host.emit('host:hello', '', r));
  const players = [];
  for (const name of ['الصقور', 'النمور', 'الذئاب']) {
    const p = mk(); await new Promise(r => p.on('connect', r));
    const res = await new Promise(r => p.emit('player:join', { name }, r));
    players.push({ p, id: res.teamId, name });
  }
  // second device joins existing team by name
  const p2 = mk(); await new Promise(r => p2.on('connect', r));
  const r2 = await new Promise(r => p2.emit('player:join', { name: 'الصقور ' }, r));
  console.log('join same team:', r2.teamId === players[0].id, 'phase', st.phase, 'teams', Object.keys(st.teams).length, 'qr', st.qr.slice(0, 22), st.joinUrl);
  const next = async () => { host.emit('host:next'); await sleep(80); };
  host.emit('host:start'); await sleep(80); console.log('after start:', st.phase, st.roundTitle);
  await next(); console.log('flag q1:', st.phase, st.q.flag, st.q.options.length, 'deadline in', Math.round((st.deadline - st.serverNow) / 1000), 's');
  // team 2 buzzes wrong, team 1 buzzes right
  players[1].p.emit('player:buzz'); await sleep(50); players[0].p.emit('player:buzz'); await sleep(50);
  console.log('holder is team2:', st.buzz.holder === players[1].id);
  const wrongIdx = st.q.options.findIndex(o => o !== 'اليابان');
  players[1].p.emit('player:answer', wrongIdx); await sleep(60);
  console.log('after wrong: locked', st.teams[players[1].id].locked, 'score', st.teams[players[1].id].score, 'holder', st.buzz.holder, 'phase', st.phase);
  players[0].p.emit('player:buzz'); await sleep(50);
  players[0].p.emit('player:answer', st.q.options.indexOf('اليابان')); await sleep(60);
  console.log('after right:', st.phase, 'score t1', st.teams[players[0].id].score, 'answer', st.result.answer, 'delta', st.result.delta);
  await next(); console.log('flag q2', st.phase, st.q.flag); host.emit('host:reveal'); await sleep(60); console.log('host reveal ->', st.phase, st.result.reason);
  host.emit('host:skipRound'); await sleep(60); console.log('skip ->', st.phase);
  await next(); console.log('round2 intro:', st.phase, st.roundTitle); await next(); console.log('map q1:', st.phase, st.q.text);
  players[0].p.emit('player:pin', { x: 850, y: 170 }); // قرب اليابان
  players[1].p.emit('player:pin', { x: 300, y: 200 }); await sleep(60);
  console.log('two pinned, phase', st.phase, 'done flags', Object.values(st.teams).map(t => t.done));
  players[2].p.emit('player:pin', { x: 700, y: 400 }); await sleep(80);
  console.log('all pinned ->', st.phase, 'target', st.result.target, 'delta', st.result.delta, 'pins', JSON.stringify(st.result.pins));
  host.emit('host:skipRound'); await sleep(60); await next(); await next();
  console.log('auction bet:', st.phase, st.q.category, 'options hidden', st.q.options === null);
  players[0].p.emit('player:bet', 500); players[1].p.emit('player:bet', 50); await sleep(60);
  console.log('bets', Object.values(st.teams).map(t => t.bet), 'phase', st.phase);
  await next(); console.log('question open:', st.phase, st.q.text, 'opts', st.q.options.length);
  players[0].p.emit('player:answer', 2); players[1].p.emit('player:answer', 0); players[2].p.emit('player:answer', 2); await sleep(80);
  console.log('reveal:', st.phase, 'delta', st.result.delta, 'detail', JSON.stringify(st.result.detail));
  host.emit('host:skipRound'); await sleep(60); await next(); console.log('end:', st.phase, Object.values(st.teams).map(t => t.name + ':' + t.score));
  host.emit('host:adjust', { id: players[2].id, delta: 30 }); await sleep(50); console.log('adjust:', st.teams[players[2].id].score);
  host.emit('host:restartScores'); await sleep(50); console.log('restart:', st.phase, Object.values(st.teams).map(t => t.score));
  host.emit('host:reset'); await sleep(50); console.log('reset:', st.phase, Object.keys(st.teams).length);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
