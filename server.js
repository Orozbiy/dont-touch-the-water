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
const ARENA_HALF = 10;        // room spans -10..10 on X and Z
const WATER_SAFE_Y = 0.0;     // y of the resting water surface
const MOVE_SPEED = 5.5;       // units/sec
const KILL_RANGE = 0.9;       // monster kill radius
const ATTACK_TIME_FAR = 1.1;  // sec for monster to strike from max distance
const ATTACK_TIME_NEAR = 0.3; // sec for monster to strike from point-blank
const COLORS = ['#ff5a5f', '#4fd1c5', '#f6c453', '#9f7aea', '#38a169', '#4299e1', '#ed64a6', '#f56565'];

// Platform layout: rectangular blocks the players jump between, floating above the water.
const PLATFORMS = [
  { x: -7, z: -7, w: 3, d: 3, y: 1.0 },
  { x: 0, z: -8, w: 2.4, d: 2.4, y: 1.3 },
  { x: 7, z: -7, w: 3, d: 3, y: 1.0 },
  { x: -8, z: 0, w: 2.4, d: 2.4, y: 0.8 },
  { x: 8, z: 0, w: 2.4, d: 2.4, y: 1.6 },
  { x: -7, z: 7, w: 3, d: 3, y: 1.2 },
  { x: 0, z: 8, w: 2.4, d: 2.4, y: 0.9 },
  { x: 7, z: 7, w: 3, d: 3, y: 1.4 },
  { x: 0, z: 0, w: 2.2, d: 2.2, y: 1.8 },
  { x: -3.5, z: -3.5, w: 1.8, d: 1.8, y: 1.0 },
  { x: 3.5, z: -3.5, w: 1.8, d: 1.8, y: 1.2 },
  { x: -3.5, z: 3.5, w: 1.8, d: 1.8, y: 1.0 },
  { x: 3.5, z: 3.5, w: 1.8, d: 1.8, y: 1.3 },
];

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

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.state = 'lobby';
    this.tick = 0;
    this.loop = null;
    this.monster = { x: 0, z: 0, targetId: null, phase: 'lurk', strikeAt: 0, lastSeenSplash: 0 };
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
    }));
  }

  spawnPoints() {
    // spawn on the big corner platforms
    return [
      { x: -7, z: -7 }, { x: 7, z: -7 }, { x: -7, z: 7 }, { x: 7, z: 7 },
      { x: 0, z: -8 }, { x: -8, z: 0 }, { x: 8, z: 0 }, { x: 0, z: 8 },
    ];
  }

  start() {
    this.resetBoard();
    this.state = 'playing';
    const spawns = this.spawnPoints();
    let i = 0;
    for (const p of this.players.values()) {
      const s = spawns[i % spawns.length];
      i++;
      p.x = s.x; p.z = s.z;
      const plat = onPlatform(p.x, p.z);
      p.y = plat ? plat.y : WATER_SAFE_Y;
      p.alive = true;
      p.inWater = false;
      p.place = null;
    }
    this.monster.x = 0; this.monster.z = 0; this.monster.phase = 'lurk'; this.monster.targetId = null;
    this.broadcast({ t: 'start', players: this.publicPlayers(), platforms: PLATFORMS });
    if (this.loop) clearInterval(this.loop);
    this.loop = setInterval(() => this.update(), TICK_MS);
  }

  resetBoard() {
    this.tick = 0;
  }

  update() {
    const dt = TICK_MS / 1000;
    this.tick += TICK_MS;

    // update player water state
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const plat = onPlatform(p.x, p.z);
      p.inWater = !plat;
      p.y = plat ? plat.y : WATER_SAFE_Y - 0.3;
    }

    // --- monster AI ---
    const alivePlayers = [...this.players.values()].filter(p => p.alive);
    const wet = alivePlayers.filter(p => p.inWater);
    const m = this.monster;

    if (wet.length === 0) {
      // nobody in the water: monster lurks near center, picks no target
      m.phase = 'lurk';
      m.targetId = null;
      const dx = 0 - m.x, dz = 0 - m.z;
      m.x += dx * dt * 0.6;
      m.z += dz * dt * 0.6;
    } else {
      // pick nearest wet player as target
      let best = null, bestDist = Infinity;
      for (const p of wet) {
        const d = Math.hypot(p.x - m.x, p.z - m.z);
        if (d < bestDist) { bestDist = d; best = p; }
      }
      if (m.phase !== 'strike' || m.targetId !== best.id) {
        m.targetId = best.id;
        m.phase = 'strike';
        // strike time scales with distance: far = ATTACK_TIME_FAR, point-blank = ATTACK_TIME_NEAR
        const maxDist = ARENA_HALF * 1.4;
        const frac = Math.max(0, Math.min(1, bestDist / maxDist));
        const duration = ATTACK_TIME_NEAR + (ATTACK_TIME_FAR - ATTACK_TIME_NEAR) * frac;
        m.strikeAt = this.tick + duration * 1000;
        m.strikeFrom = { x: m.x, z: m.z };
      }
      const target = this.players.get(m.targetId);
      if (target && target.alive) {
        const remaining = Math.max(0, m.strikeAt - this.tick);
        const total = Math.max(1, m.strikeAt - (this.tick - TICK_MS));
        // lerp monster position toward target as the strike timer counts down fast at the end
        const k = Math.min(1, dt * 9);
        m.x += (target.x - m.x) * k;
        m.z += (target.z - m.z) * k;
        if (this.tick >= m.strikeAt) {
          const d = Math.hypot(target.x - m.x, target.z - m.z);
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
      monster: { x: m.x, z: m.z, phase: m.phase, targetId: m.targetId, strikeAt: m.strikeAt, tick: this.tick },
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
      ws.send(JSON.stringify({ t: 'joined', code, id, color, players: room.publicPlayers(), state: room.state, platforms: PLATFORMS }));
      room.broadcast({ t: 'lobby', players: room.publicPlayers(), code });
      return;
    }

    if (!room || !player) return;

    if (msg.t === 'start') { room.start(); return; }
    if (msg.t === 'restart') { room.start(); return; }

    if (msg.t === 'move' && room.state === 'playing' && player.alive) {
      // client sends intended absolute position deltas each tick (simple client-authoritative movement, clamped)
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
