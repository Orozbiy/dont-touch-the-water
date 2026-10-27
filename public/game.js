(() => {
  const $ = (id) => document.getElementById(id);

  const joinScreen = $('joinScreen');
  const lobbyScreen = $('lobbyScreen');
  const gameScreen = $('gameScreen');
  const resultScreen = $('resultScreen');

  const nameInput = $('nameInput');
  const codeInput = $('codeInput');
  const joinBtn = $('joinBtn');
  const roomCodeEl = $('roomCode');
  const playerListEl = $('playerList');
  const startBtn = $('startBtn');
  const timerEl = $('timer');
  const aliveCountEl = $('aliveCount');
  const toastEl = $('toast');
  const resultListEl = $('resultList');
  const resultTitleEl = $('resultTitle');
  const playAgainBtn = $('playAgainBtn');
  const connStatusEl = $('connStatus');
  const connStatus2El = $('connStatus2');

  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');

  let ws = null;
  let myId = null;
  let myColor = null;
  let roomCode = null;
  let GRID = 14;
  let players = [];
  let deadBlocks = new Set(); // "x,y"
  let waterLevel = 0;
  let waterRow = GRID;
  let elapsed = 0;
  let gameState = 'lobby';
  let lastToastKey = '';

  // remembered name/code
  nameInput.value = localStorage.getItem('dtw_name') || '';
  const urlCode = new URLSearchParams(location.search).get('room');
  if (urlCode) codeInput.value = urlCode.toUpperCase();

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + location.host;
  }

  function connect() {
    ws = new WebSocket(wsUrl());
    ws.onopen = () => { connStatus2El.textContent = ''; };
    ws.onclose = () => {
      connStatus2El.textContent = 'Байланыш үзүлдү... кайра аракет кылынууда';
      connStatusEl.textContent = '● Офлайн';
      setTimeout(connect, 1500);
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    };
  }
  connect();

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function showScreen(el) {
    [joinScreen, lobbyScreen, gameScreen, resultScreen].forEach(s => s.classList.add('hidden'));
    el.classList.remove('hidden');
  }

  joinBtn.addEventListener('click', () => {
    const name = nameInput.value.trim() || 'Oюнчу';
    localStorage.setItem('dtw_name', name);
    const code = codeInput.value.trim().toUpperCase();
    send({ t: 'join', name, code });
  });

  startBtn.addEventListener('click', () => send({ t: 'start' }));
  playAgainBtn.addEventListener('click', () => {
    send({ t: 'restart' });
    showScreen(lobbyScreen);
  });

  function handleMessage(msg) {
    if (msg.t === 'joined') {
      myId = msg.id;
      myColor = msg.color;
      roomCode = msg.code;
      GRID = msg.grid;
      players = msg.players;
      roomCodeEl.textContent = roomCode;
      history.replaceState(null, '', '?room=' + roomCode);
      renderPlayerList();
      if (msg.state === 'lobby') showScreen(lobbyScreen);
      return;
    }
    if (msg.t === 'lobby') {
      players = msg.players;
      roomCode = msg.code;
      roomCodeEl.textContent = roomCode;
      renderPlayerList();
      if (gameState !== 'playing') showScreen(lobbyScreen);
      return;
    }
    if (msg.t === 'start') {
      GRID = msg.grid;
      players = msg.players;
      deadBlocks = new Set();
      waterLevel = 0;
      waterRow = GRID;
      gameState = 'playing';
      showScreen(gameScreen);
      resizeCanvas();
      return;
    }
    if (msg.t === 'tick') {
      elapsed = msg.elapsed;
      waterLevel = msg.waterLevel;
      waterRow = msg.waterRow;
      deadBlocks = new Set(msg.blocks.map(([x, y]) => x + ',' + y));
      const prevAlive = new Map(players.map(p => [p.id, p.alive]));
      players = msg.players;
      // toast if I just died
      const me = players.find(p => p.id === myId);
      if (me && prevAlive.get(myId) !== false && me.alive === false) {
        showToast('💦 Сен чөктүң!', '#ff5a5f');
      }
      timerEl.textContent = Math.floor(elapsed / 1000) + 'с';
      aliveCountEl.textContent = players.filter(p => p.alive).length + ' 👤';
      return;
    }
    if (msg.t === 'end') {
      gameState = 'ended';
      players = msg.players;
      showResult(msg.winner);
      return;
    }
  }

  function showToast(text, color) {
    toastEl.textContent = text;
    toastEl.style.color = color || '#fff';
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 1400);
  }

  function renderPlayerList() {
    playerListEl.innerHTML = '';
    players.forEach(p => {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.innerHTML = `<span class="dot" style="background:${p.color}"></span>${escapeHtml(p.name)}${p.id === myId ? ' (сен)' : ''}`;
      playerListEl.appendChild(chip);
    });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showResult(winnerName) {
    const me = players.find(p => p.id === myId);
    if (winnerName && me && me.name === winnerName) {
      resultTitleEl.textContent = '🏆 Сен жеңдиң!';
    } else if (winnerName) {
      resultTitleEl.textContent = '🏁 Жеңүүчү: ' + winnerName;
    } else {
      resultTitleEl.textContent = 'Оюн бүттү';
    }
    resultListEl.innerHTML = '';
    const sorted = [...players].sort((a, b) => (b.alive - a.alive));
    sorted.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'result-row';
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '.';
      row.innerHTML = `<span class="medal">${medal}</span><span class="dot" style="background:${p.color}"></span>${escapeHtml(p.name)}${p.id === myId ? ' (сен)' : ''}`;
      resultListEl.appendChild(row);
    });
    showScreen(resultScreen);
  }

  // ---------- Controls ----------
  document.querySelectorAll('.dpad button[data-dir]').forEach(btn => {
    const fire = (e) => { e.preventDefault(); send({ t: 'move', dir: btn.dataset.dir }); };
    btn.addEventListener('touchstart', fire, { passive: false });
    btn.addEventListener('mousedown', fire);
  });

  window.addEventListener('keydown', (e) => {
    const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };
    const dir = map[e.key];
    if (dir) { e.preventDefault(); send({ t: 'move', dir }); }
  });

  // simple swipe support on canvas
  let touchStart = null;
  canvas.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  canvas.addEventListener('touchend', (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) { touchStart = null; return; }
    if (Math.abs(dx) > Math.abs(dy)) send({ t: 'move', dir: dx > 0 ? 'right' : 'left' });
    else send({ t: 'move', dir: dy > 0 ? 'down' : 'up' });
    touchStart = null;
  }, { passive: true });

  // ---------- Isometric rendering ----------
  function resizeCanvas() {
    const wrap = canvas.parentElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = wrap.clientWidth * dpr;
    canvas.height = wrap.clientHeight * dpr;
    canvas.style.width = wrap.clientWidth + 'px';
    canvas.style.height = wrap.clientHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  const TILE_W = 44, TILE_H = 24, TILE_DEPTH = 14;

  function project(gx, gy, originX, originY) {
    const sx = originX + (gx - gy) * (TILE_W / 2);
    const sy = originY + (gx + gy) * (TILE_H / 2);
    return [sx, sy];
  }

  function drawTileTop(sx, sy, color) {
    ctx.beginPath();
    ctx.moveTo(sx, sy - TILE_H / 2);
    ctx.lineTo(sx + TILE_W / 2, sy);
    ctx.lineTo(sx, sy + TILE_H / 2);
    ctx.lineTo(sx - TILE_W / 2, sy);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  function shade(hex, amt) {
    const c = hex.replace('#', '');
    const num = parseInt(c, 16);
    let r = (num >> 16) + amt, g = ((num >> 8) & 0xff) + amt, b = (num & 0xff) + amt;
    r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
    return `rgb(${r},${g},${b})`;
  }

  function drawBlock(sx, sy, topColor) {
    // left face
    ctx.beginPath();
    ctx.moveTo(sx - TILE_W / 2, sy);
    ctx.lineTo(sx, sy + TILE_H / 2);
    ctx.lineTo(sx, sy + TILE_H / 2 + TILE_DEPTH);
    ctx.lineTo(sx - TILE_W / 2, sy + TILE_DEPTH);
    ctx.closePath();
    ctx.fillStyle = shade(topColor, -45);
    ctx.fill();
    // right face
    ctx.beginPath();
    ctx.moveTo(sx + TILE_W / 2, sy);
    ctx.lineTo(sx, sy + TILE_H / 2);
    ctx.lineTo(sx, sy + TILE_H / 2 + TILE_DEPTH);
    ctx.lineTo(sx + TILE_W / 2, sy + TILE_DEPTH);
    ctx.closePath();
    ctx.fillStyle = shade(topColor, -25);
    ctx.fill();
    // top
    drawTileTop(sx, sy, topColor);
  }

  let animT = 0;

  function render() {
    animT += 0.02;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    const originX = w / 2;
    const originY = h / 2 - (GRID * TILE_H) / 2 + 40;

    // sort tiles back-to-front for correct overlap (painter's algorithm)
    const order = [];
    for (let x = 0; x < GRID; x++) for (let y = 0; y < GRID; y++) order.push([x, y]);
    order.sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));

    // water color pulsates slightly
    const waterColor = `rgba(43, 127, 214, ${0.85 + Math.sin(animT) * 0.05})`;

    for (const [x, y] of order) {
      const [sx, sy] = project(x, y, originX, originY);
      const key = x + ',' + y;
      const isDead = deadBlocks.has(key);
      const isFlooded = y >= waterRow;

      if (isDead || isFlooded) {
        // water tile (slightly animated top)
        const bob = Math.sin(animT * 2 + x * 0.6 + y * 0.6) * 1.5;
        drawTileTop(sx, sy + bob, waterColor);
        continue;
      }
      const base = '#d9b36c';
      const grad = (x + y) % 2 === 0 ? base : shade(base, -8);
      drawBlock(sx, sy, grad);
    }

    // players (draw after tiles, sorted by depth too)
    const sortedPlayers = [...players].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    for (const p of sortedPlayers) {
      const [sx, sy] = project(p.x, p.y, originX, originY);
      const bob = p.alive ? Math.sin(animT * 3 + p.x + p.y) * 2 : 6;
      const py = sy - 16 + bob;
      ctx.globalAlpha = p.alive ? 1 : 0.35;
      // shadow
      ctx.beginPath();
      ctx.ellipse(sx, sy + 2, 10, 4, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fill();
      // body
      ctx.beginPath();
      ctx.arc(sx, py, 9, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = p.id === myId ? '#fff' : 'rgba(255,255,255,0.5)';
      ctx.stroke();
      // name
      ctx.globalAlpha = p.alive ? 1 : 0.5;
      ctx.font = '600 10px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 3;
      ctx.fillText(p.name, sx, py - 14);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }

    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);
})();
