// ===============================================
//  جولة العالم — خادم اللعبة (Node + Socket.io)
//  التشغيل:  node server.js   ثم افتح /host على الشاشة الكبيرة
// ===============================================
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const d3 = require('d3-geo');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const HOST_KEY = process.env.HOST_KEY || ''; // اختياري: كلمة سر لشاشة المضيف
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));
app.get('/host', (_, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

// ---------- البيانات ----------
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
const WORLD = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'world.json'), 'utf8'));
const COUNTRY = Object.fromEntries(WORLD.countries.map(c => [c.id, c]));
const projection = d3.geoNaturalEarth1().scale(WORLD.scale).translate(WORLD.translate);

const CFG = {
  flag: { buzzWindow: 25, answerWindow: 8, correct: 100, wrong: -50 },
  map: { window: 30, maxPoints: 100, radius: 0.22 }, // radius: نسبة من عرض الخريطة يصبح بعدها الناتج صفر
  auction: { betWindow: 20, answerWindow: 20, minBet: 10, floor: 100 },
};

// ---------- الحالة ----------
let S;
let timer = null;
function fresh() {
  return {
    phase: 'lobby', // lobby | intro | bet | question | reveal | leaderboard | end
    round: -1, qIndex: -1,
    teams: {}, // id -> {id,name,score,members,online}
    q: null,     // السؤال الحالي (نسخة عامة بدون الإجابة)
    deadline: 0,
    buzz: null,  // {holder, since, locked:[]}
    inputs: {},  // teamId -> {choice|x,y|bet}
    result: null, // بعد الكشف
    joinUrl: '', qr: '',
  };
}
S = fresh();

function lanIp() {
  for (const ifs of Object.values(os.networkInterfaces()))
    for (const i of ifs) if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}
async function setJoinInfo(url) {
  S.joinUrl = url;
  S.qr = await QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: '#0f172a', light: '#ffffff' } });
}

const uid = () => Math.random().toString(36).slice(2, 8);
const norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const now = () => Date.now();
const roundDef = () => QUESTIONS.rounds[S.round];
const rawQ = () => roundDef() && roundDef().questions[S.qIndex];

function publicQ(q, type) {
  if (!q) return null;
  const base = { type, text: q.text || '' };
  if (type === 'flag') return { ...base, flag: q.flag, options: q.options, text: q.text || 'ما هذه الدولة؟' };
  if (type === 'map') return { ...base, label: q.label || '' };
  if (type === 'auction') return { ...base, category: q.category, difficulty: q.difficulty || '', options: S.phase === 'bet' ? null : q.options };
  return base;
}

function teamPublic() {
  const out = {};
  for (const t of Object.values(S.teams)) {
    const inp = S.inputs[t.id];
    out[t.id] = {
      id: t.id, name: t.name, score: t.score, online: t.online > 0, members: t.online,
      done: !!(inp && inp.done), bet: inp && inp.bet != null ? inp.bet : null,
      locked: !!(S.buzz && S.buzz.locked.includes(t.id)),
    };
  }
  return out;
}

function snapshot() {
  const rd = roundDef();
  return {
    phase: S.phase, round: S.round, qIndex: S.qIndex,
    roundTitle: rd ? rd.title : '', roundDesc: rd ? rd.desc : '', roundType: rd ? rd.type : null,
    totalQ: rd ? rd.questions.length : 0, totalRounds: QUESTIONS.rounds.length,
    q: S.q, deadline: S.deadline, serverNow: now(),
    buzz: S.buzz ? { holder: S.buzz.holder, locked: S.buzz.locked, answering: S.buzz.answering } : null,
    teams: teamPublic(), result: S.result,
    joinUrl: S.joinUrl, qr: S.qr, cfg: CFG,
  };
}
function broadcast() { io.emit('state', snapshot()); }

function setTimer(sec, fn) {
  clearTimeout(timer);
  S.deadline = now() + sec * 1000;
  timer = setTimeout(fn, sec * 1000 + 150);
}
function clearTimer() { clearTimeout(timer); timer = null; S.deadline = 0; }

// ---------- تدفق اللعبة ----------
function startRound(r) {
  S.round = r; S.qIndex = -1; S.q = null; S.result = null; S.inputs = {}; S.buzz = null;
  clearTimer();
  if (!roundDef()) { S.phase = 'end'; return broadcast(); }
  S.phase = 'intro';
  broadcast();
}

function nextQuestion() {
  const rd = roundDef();
  if (!rd) return;
  if (S.qIndex + 1 >= rd.questions.length) { S.phase = 'leaderboard'; S.q = null; S.result = null; clearTimer(); return broadcast(); }
  S.qIndex += 1; S.inputs = {}; S.result = null; S.buzz = null;
  const q = rawQ();
  if (rd.type === 'flag') {
    S.phase = 'question'; S.buzz = { holder: null, locked: [], answering: false };
    S.q = publicQ(q, 'flag');
    setTimer(CFG.flag.buzzWindow, () => reveal('timeout'));
  } else if (rd.type === 'map') {
    S.phase = 'question'; S.q = publicQ(q, 'map');
    setTimer(CFG.map.window, () => reveal('timeout'));
  } else if (rd.type === 'auction') {
    S.phase = 'bet'; S.q = publicQ(q, 'auction');
    setTimer(CFG.auction.betWindow, openAuctionQuestion);
  }
  broadcast();
}

function openAuctionQuestion() {
  if (S.phase !== 'bet') return;
  // من لم يراهن يُعتبر رهانه الحد الأدنى
  for (const t of Object.values(S.teams)) {
    if (!S.inputs[t.id]) S.inputs[t.id] = {};
    if (S.inputs[t.id].bet == null) S.inputs[t.id].bet = CFG.auction.minBet;
    S.inputs[t.id].done = false;
  }
  S.phase = 'question'; S.q = publicQ(rawQ(), 'auction');
  setTimer(CFG.auction.answerWindow, () => reveal('timeout'));
  broadcast();
}

function targetXY(q) {
  if (q.lat != null && q.lon != null) { const p = projection([q.lon, q.lat]); return { x: p[0], y: p[1] }; }
  const c = COUNTRY[q.country];
  return c ? { x: c.cx, y: c.cy, bbox: c.bbox } : { x: 0, y: 0 };
}

function reveal(reason) {
  if (S.phase === 'reveal' || S.phase === 'leaderboard') return;
  clearTimer();
  const rd = roundDef(); const q = rawQ();
  const result = { reason, delta: {}, answer: null, detail: {} };
  if (rd.type === 'flag') {
    result.answer = q.answer;
    result.answerIndex = q.options.indexOf(q.answer);
    // النقاط أُضيفت لحظة الإجابة؛ هنا فقط نكشف
    for (const [tid, d] of Object.entries(S.inputs)) result.delta[tid] = d.delta || 0;
  } else if (rd.type === 'map') {
    const t = targetXY(q);
    result.answer = q.label || (COUNTRY[q.country] && COUNTRY[q.country].name) || '';
    result.target = { x: t.x, y: t.y, country: q.country || null };
    result.pins = {};
    const R = CFG.map.radius * WORLD.width;
    for (const team of Object.values(S.teams)) {
      const inp = S.inputs[team.id];
      if (!inp || inp.x == null) { result.delta[team.id] = 0; continue; }
      const dist = Math.hypot(inp.x - t.x, inp.y - t.y);
      let pts;
      const inside = t.bbox && inp.x >= t.bbox[0] && inp.x <= t.bbox[2] && inp.y >= t.bbox[1] && inp.y <= t.bbox[3];
      if (inside) pts = CFG.map.maxPoints;
      else pts = Math.round(CFG.map.maxPoints * Math.max(0, 1 - dist / R));
      team.score += pts; result.delta[team.id] = pts;
      result.pins[team.id] = { x: inp.x, y: inp.y, dist: Math.round(dist), inside: !!inside };
    }
  } else if (rd.type === 'auction') {
    result.answer = q.options[q.answer]; result.answerIndex = q.answer;
    for (const team of Object.values(S.teams)) {
      const inp = S.inputs[team.id] || {};
      const bet = inp.bet == null ? CFG.auction.minBet : inp.bet;
      const ok = inp.choice === q.answer;
      const d = ok ? bet : -bet;
      team.score += d; result.delta[team.id] = d;
      result.detail[team.id] = { bet, choice: inp.choice == null ? null : inp.choice, ok };
    }
  }
  S.result = result; S.phase = 'reveal';
  broadcast();
}

// جولة الأعلام: ضغط الجرس
function onBuzz(teamId) {
  if (S.phase !== 'question' || roundDef().type !== 'flag' || !S.buzz) return;
  if (S.buzz.holder || S.buzz.locked.includes(teamId)) return;
  S.buzz.holder = teamId; S.buzz.answering = true; S.buzz.since = now();
  S.buzz.buzzRemaining = Math.max(0, S.deadline - now());
  setTimer(CFG.flag.answerWindow, () => flagAnswer(teamId, -1));
  broadcast();
}
function flagAnswer(teamId, choice) {
  if (S.phase !== 'question' || !S.buzz || S.buzz.holder !== teamId) return;
  const q = rawQ(); const team = S.teams[teamId];
  const ok = q.options[choice] === q.answer;
  S.inputs[teamId] = S.inputs[teamId] || {};
  if (ok) {
    team.score += CFG.flag.correct; S.inputs[teamId].delta = CFG.flag.correct; S.inputs[teamId].done = true;
    S.buzz.answering = false;
    return reveal('answered');
  }
  team.score += CFG.flag.wrong; S.inputs[teamId].delta = CFG.flag.wrong; S.inputs[teamId].done = true;
  S.buzz.locked.push(teamId); S.buzz.holder = null; S.buzz.answering = false;
  const remaining = Object.keys(S.teams).filter(id => !S.buzz.locked.includes(id));
  if (!remaining.length) return reveal('all-locked');
  // إعادة فتح الجرس للبقية بما تبقى من الوقت (10 ثوانٍ على الأقل)
  const rem = Math.max(10, Math.round((S.buzz.buzzRemaining || 0) / 1000));
  setTimer(rem, () => reveal('timeout'));
  broadcast();
}

function allDone() {
  const ids = Object.keys(S.teams);
  return ids.length > 0 && ids.every(id => S.inputs[id] && S.inputs[id].done);
}

// ---------- الاتصال ----------
io.on('connection', socket => {
  socket.emit('state', snapshot());

  // ---- المضيف ----
  socket.on('host:hello', (key, cb) => {
    if (HOST_KEY && key !== HOST_KEY) return cb && cb({ ok: false });
    socket.data.host = true; cb && cb({ ok: true });
  });
  const hostOnly = fn => (...a) => { if (socket.data.host) fn(...a); };
  socket.on('host:start', hostOnly(() => { if (S.phase === 'lobby') startRound(0); }));
  socket.on('host:next', hostOnly(() => {
    if (S.phase === 'intro') nextQuestion();
    else if (S.phase === 'reveal') nextQuestion();
    else if (S.phase === 'leaderboard') startRound(S.round + 1);
    else if (S.phase === 'bet') openAuctionQuestion();
    else if (S.phase === 'question') reveal('host');
  }));
  socket.on('host:reveal', hostOnly(() => { if (S.phase === 'question') reveal('host'); }));
  socket.on('host:skipRound', hostOnly(() => { S.phase = 'leaderboard'; S.q = null; S.result = null; clearTimer(); broadcast(); }));
  socket.on('host:kick', hostOnly(id => { delete S.teams[id]; delete S.inputs[id]; broadcast(); }));
  socket.on('host:adjust', hostOnly(({ id, delta }) => { if (S.teams[id]) { S.teams[id].score += Number(delta) || 0; broadcast(); } }));
  socket.on('host:reset', hostOnly(() => {
    const { joinUrl, qr } = S; clearTimer(); S = fresh(); S.joinUrl = joinUrl; S.qr = qr;
    io.emit('reset'); broadcast();
  }));
  socket.on('host:restartScores', hostOnly(() => {
    clearTimer(); for (const t of Object.values(S.teams)) t.score = 0;
    S.phase = 'lobby'; S.round = -1; S.qIndex = -1; S.q = null; S.result = null; S.inputs = {}; S.buzz = null; broadcast();
  }));

  // ---- اللاعب ----
  socket.on('player:join', ({ name, teamId }, cb) => {
    let team = teamId && S.teams[teamId];
    if (!team && name) {
      const n = norm(name);
      team = Object.values(S.teams).find(t => norm(t.name) === n);
      if (!team) {
        if (!n || n.length > 24) return cb && cb({ ok: false, error: 'اسم غير صالح' });
        team = { id: uid(), name: String(name).trim().slice(0, 24), score: 0, online: 0 };
        S.teams[team.id] = team;
      }
    }
    if (!team) return cb && cb({ ok: false, error: 'الفريق غير موجود' });
    if (socket.data.teamId && S.teams[socket.data.teamId]) S.teams[socket.data.teamId].online = Math.max(0, S.teams[socket.data.teamId].online - 1);
    socket.data.teamId = team.id; team.online += 1;
    cb && cb({ ok: true, teamId: team.id, name: team.name });
    broadcast();
  });
  socket.on('player:leave', () => {
    const t = S.teams[socket.data.teamId];
    if (t) { t.online = Math.max(0, t.online - 1); if (S.phase === 'lobby' && t.online === 0) delete S.teams[t.id]; }
    socket.data.teamId = null; broadcast();
  });
  socket.on('player:buzz', () => { if (socket.data.teamId) onBuzz(socket.data.teamId); });
  socket.on('player:answer', choice => {
    const tid = socket.data.teamId; if (!tid || S.phase !== 'question') return;
    const type = roundDef().type;
    if (type === 'flag') return flagAnswer(tid, Number(choice));
    if (type === 'auction') {
      S.inputs[tid] = S.inputs[tid] || {}; if (S.inputs[tid].done) return;
      S.inputs[tid].choice = Number(choice); S.inputs[tid].done = true;
      if (allDone()) return reveal('all-answered');
      broadcast();
    }
  });
  socket.on('player:pin', ({ x, y }) => {
    const tid = socket.data.teamId; if (!tid || S.phase !== 'question' || roundDef().type !== 'map') return;
    S.inputs[tid] = S.inputs[tid] || {}; if (S.inputs[tid].done) return;
    S.inputs[tid].x = Math.max(0, Math.min(WORLD.width, Number(x))); S.inputs[tid].y = Math.max(0, Math.min(WORLD.height, Number(y)));
    S.inputs[tid].done = true;
    if (allDone()) return reveal('all-answered');
    broadcast();
  });
  socket.on('player:bet', amount => {
    const tid = socket.data.teamId; if (!tid || S.phase !== 'bet') return;
    const team = S.teams[tid];
    const max = Math.max(CFG.auction.floor, team.score);
    const bet = Math.round(Math.max(CFG.auction.minBet, Math.min(max, Number(amount) || 0)));
    S.inputs[tid] = { bet, done: true };
    if (allDone()) return openAuctionQuestion();
    broadcast();
  });

  socket.on('disconnect', () => {
    const t = S.teams[socket.data.teamId];
    if (t) { t.online = Math.max(0, t.online - 1); broadcast(); }
  });
});

server.listen(PORT, async () => {
  const url = process.env.PUBLIC_URL || `http://${lanIp()}:${PORT}`;
  await setJoinInfo(url);
  console.log(`\n  جولة العالم جاهزة\n  شاشة المضيف:  http://localhost:${PORT}/host\n  رابط اللاعبين: ${url}\n`);
});
