const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const TICK_MS = 50;
const ARENA_HALF = 10;
const MOVE_SPEED = 5.5;
const PLATFORM_Y = 0.5;
const COLORS = ['#ff5a5f', '#4fd1c5', '#f6c453', '#9f7aea', '#38a169', '#4299e1', '#ed64a6', '#f56565'];

// --- "Simon says" grid of platforms, all at the same height, all solid. ---
const GRID_N = 5;            // 5x5 grid of platforms
const CELL = 3.4;            // spacing between platform centers
const PLAT_SIZE = 2.2;       // platform footprint

const PLATFORMS = [];
{
  const half = (GRID_N - 1) / 2;
  let id = 0;
  for (let gx = 0; gx < GRID_N; gx++) {
    for (let gz = 0; gz < GRID_N; gz++) {
      PLATFORMS.push({
        id: id++,
        x: (gx - half) * CELL,
        z: (gz - half) * CELL,
        w: PLAT_SIZE, d: PLAT_SIZE, y: PLATFORM_Y,
      });
    }
  }
}

function onPlatform(x, z) {
  for (const p of PLATFORMS) {
    if (Math.abs(x - p.x) <= p.w / 2 && Math.abs(z - p.z) <= p.d / 2) return p;
  }
  return null;
}

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

const rooms = new Map();

// Round phases:
//  'show'   - sequence is revealed one platform at a time (safe period)
//  'repeat' - players must step on platforms in the same order
//  'clear'  - brief pause between rounds
class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.state = 'lobby'; // lobby | playing | ended
    this.tick = 0;
    this.loop = null;

    this.round = 0;
    this.sequence = [];        // array of platform ids for this round
    this.phase = 'clear';
    this.phaseUntil = 0;
    this.showIndex = 0;
    this.litPlatform = null;   // id currently lit during 'show'
    this.playerProgress = new Map(); // id -> how many correct steps taken this round
    this.playerOnPlatform = new Map(); // id -> platform id currently standing on (committed)

    this.monster = { x: 0, z: 0, targetId: null, phase: 'lurk', strikeAt: 0 };
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
    }
  }

  publicPlayers() {
    return [...this.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, z: p.z, alive: p.alive, inWater: p.inWater,
      progress: this.playerProgress.get(p.id) || 0,
    }));
  }

  spawnPoints() {
    // ring of spawn points just outside the grid, players walk in
    const r = (GRID_N * CELL) / 2 + 2;
    const pts = [];
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
    }
    return pts;
  }

  start() {
    this.state = 'playing';
    this.tick = 0;
    this.round = 0;
    const spawns = this.spawnPoints();
    let i = 0;
    for (const p of this.players.values()) {
      const s = spawns[i % spawns.length];
      i++;
      p.x = s.x; p.z = s.z; p.y = 0.2;
      p.alive = true;
      p.inWater = true; // start off-grid, in the water ring, but safe (monster only active during 'repeat')
      p.place = null;
      this.playerProgress.set(p.id, 0);
      this.playerOnPlatform.set(p.id, null);
    }
    this.monster.x = 0; this.monster.z = 0; this.monster.phase = 'lurk'; this.monster.targetId = null;
    this.broadcast({ t: 'start', players: this.publicPlayers(), platforms: PLATFORMS, gridN: GRID_N, cell: CELL });
    this.beginRound();
    if (this.loop) clearInterval(this.loop);
    this.loop = setInterval(() => this.update(), TICK_MS);
  }

  beginRound() {
    this.round++;
    const seqLen = Math.min(PLATFORMS.length, 2 + this.round); // grows each round
    this.sequence = [];
    const used = new Set();
    while (this.sequence.length < seqLen) {
      const id = Math.floor(Math.random() * PLATFORMS.length);
      if (used.has(id)) continue; // no immediate repeats within a round for clarity
      used.add(id);
      this.sequence.push(id);
    }
    for (const id of this.playerProgress.keys()) this.playerProgress.set(id, 0);
    for (const id of this.playerOnPlatform.keys()) this.playerOnPlatform.set(id, null);

    this.phase = 'show';
    this.showIndex = 0;
    this.litPlatform = this.sequence[0];
    const showStepMs = 850;
    this.phaseUntil = this.tick + showStepMs;
    this.showStepMs = showStepMs;

    this.broadcast({
      t: 'round',
      round: this.round,
      length: this.sequence.length,
    });
  }

  update() {
    const dt = TICK_MS / 1000;
    this.tick += TICK_MS;

    const alivePlayers = [...this.players.values()].filter(p => p.alive);

    // --- phase machine ---
    if (this.phase === 'show') {
      if (this.tick >= this.phaseUntil) {
        this.showIndex++;
        if (this.showIndex >= this.sequence.length) {
          this.phase = 'repeat';
          this.litPlatform = null;
          this.phaseUntil = this.tick + 16000; // time limit to complete the sequence
        } else {
          this.litPlatform = this.sequence[this.showIndex];
          this.phaseUntil = this.tick + this.showStepMs;
        }
      }
    } else if (this.phase === 'repeat') {
      // check each alive player's current platform against expected next step
      for (const p of alivePlayers) {
        const plat = onPlatform(p.x, p.z);
        p.inWater = !plat;
        p.y = plat ? plat.y : 0.2;
        const platId = plat ? plat.id : null;
        const prevStanding = this.playerOnPlatform.get(p.id);

        if (platId !== null && platId !== prevStanding) {
          // player just stepped onto a new platform
          const expected = this.sequence[this.playerProgress.get(p.id) || 0];
          if (platId === expected) {
            this.playerProgress.set(p.id, (this.playerProgress.get(p.id) || 0) + 1);
          } else {
            // wrong platform: eliminated
            p.alive = false;
            p.place = alivePlayers.length;
          }
        }
        this.playerOnPlatform.set(p.id, platId);
      }

      const stillAlive = [...this.players.values()].filter(p => p.alive);
      const allDone = stillAlive.length > 0 && stillAlive.every(p => (this.playerProgress.get(p.id) || 0) >= this.sequence.length);
      const timeUp = this.tick >= this.phaseUntil;

      if (timeUp) {
        // anyone still off-grid or mid-sequence when time runs out is eliminated
        for (const p of stillAlive) {
          if ((this.playerProgress.get(p.id) || 0) < this.sequence.length) {
            p.alive = false;
            p.place = stillAlive.length;
          }
        }
      }

      if (allDone || timeUp) {
        this.phase = 'clear';
        this.phaseUntil = this.tick + 1800;
      }
    } else if (this.phase === 'clear') {
      if (this.tick >= this.phaseUntil) {
        const stillAlive = [...this.players.values()].filter(p => p.alive);
        if (stillAlive.length > 1) {
          this.beginRound();
        }
      }
    }

    // --- monster AI: only active while 'repeat', hunts anyone in the water ---
    const wet = alivePlayers.filter(p => p.inWater);
    const m = this.monster;
    if (this.phase !== 'repeat' || wet.length === 0) {
      m.phase = 'lurk';
      m.targetId = null;
      m.x += (0 - m.x) * dt * 0.6;
      m.z += (0 - m.z) * dt * 0.6;
    } else {
      let best = null, bestDist = Infinity;
      for (const p of wet) {
        const d = Math.hypot(p.x - m.x, p.z - m.z);
        if (d < bestDist) { bestDist = d; best = p; }
      }
      if (m.phase !== 'strike' || m.targetId !== best.id) {
        m.targetId = best.id;
        m.phase = 'strike';
        const maxDist = ARENA_HALF * 1.4;
        const frac = Math.max(0, Math.min(1, bestDist / maxDist));
        const duration = 0.3 + (1.1 - 0.3) * frac;
        m.strikeAt = this.tick + duration * 1000;
      }
      const target = this.players.get(m.targetId);
      if (target && target.alive) {
        const k = Math.min(1, dt * 9);
        m.x += (target.x - m.x) * k;
        m.z += (target.z - m.z) * k;
        if (this.tick >= m.strikeAt) {
          if (target.inWater) {
            target.alive = false;
            target.place = alivePlayers.length;
          }
          m.phase = 'lurk';
          m.targetId = null;
        }
      }
    }

    const nowAlive = [...this.players.values()].filter(p => p.alive);
    this.broadcast({
      t: 'tick',
      elapsed: this.tick,
      players: this.publicPlayers(),
      monster: { x: m.x, z: m.z, phase: m.phase, targetId: m.targetId },
      phase: this.phase,
      litPlatform: this.phase === 'show' ? this.litPlatform : null,
      round: this.round,
      seqLength: this.sequence.length,
      phaseRemaining: Math.max(0, this.phaseUntil - this.tick),
    });

    if (nowAlive.length <= 1 && this.players.size > 1) {
      this.state = 'ended';
      this.broadcast({ t: 'end', winner: nowAlive[0] ? nowAlive[0].name : null, players: this.publicPlayers() });
      clearInterval(this.loop);
      this.loop = null;
    } else if (this.players.size === 1 && nowAlive.length === 0) {
      this.state = 'ended';
      this.broadcast({ t: 'end', winner: null, players: this.publicPlayers() });
      clearInterval(this.loop);
      this.loop = null;
    }
  }
}

function getOrCreateRoom(code) {
  if (!rooms.has(code)) rooms.set(code, new Room(code));
  return rooms.get(code);
}

wss.on('connection', (ws) => {
  const id = crypto.randomUUID();
  let room = null;
  let player = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'join') {
      const code = (msg.code || '').toUpperCase().trim() || makeCode();
      room = getOrCreateRoom(code);
      const color = COLORS[room.players.size % COLORS.length];
      player = {
        id, ws, name: (msg.name || 'Oюнчу').slice(0, 16), color,
        x: -7, y: 1, z: -7, alive: true, inWater: false, place: null,
      };
      room.players.set(id, player);
      ws.send(JSON.stringify({
        t: 'joined', code, id, color, players: room.publicPlayers(), state: room.state,
        platforms: PLATFORMS, gridN: GRID_N, cell: CELL,
      }));
      room.broadcast({ t: 'lobby', players: room.publicPlayers(), code });
      return;
    }

    if (!room || !player) return;

    if (msg.t === 'start') { room.start(); return; }
    if (msg.t === 'restart') { room.start(); return; }

    if (msg.t === 'move' && room.state === 'playing' && player.alive) {
      const nx = Math.max(-ARENA_HALF, Math.min(ARENA_HALF, msg.x));
      const nz = Math.max(-ARENA_HALF, Math.min(ARENA_HALF, msg.z));
      player.x = nx;
      player.z = nz;
      return;
    }
  });

  ws.on('close', () => {
    if (room && player) {
      room.players.delete(id);
      room.playerProgress.delete(id);
      room.playerOnPlatform.delete(id);
      if (room.players.size === 0) {
        if (room.loop) clearInterval(room.loop);
        rooms.delete(room.code);
      } else {
        room.broadcast({ t: 'lobby', players: room.publicPlayers(), code: room.code });
      }
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('Server running on port ' + PORT));
