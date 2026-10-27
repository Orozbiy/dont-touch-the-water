const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const GRID = 14; // 14x14 blocks
const TICK_MS = 50;
const COLORS = ['#ff5a5f', '#4fd1c5', '#f6c453', '#9f7aea', '#38a169', '#f56565', '#4299e1', '#ed64a6'];

/** @type {Map<string, Room>} */
const rooms = new Map();

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // id -> player
    this.state = 'lobby'; // lobby | playing | ended
    this.blocks = [];
    this.waterLevel = 0; // 0..1, fraction of grid "flooded" visually (height offset)
    this.startedAt = 0;
    this.tick = 0;
    this.nextBlockFallAt = 0;
    this.loop = null;
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
    }
  }

  resetBoard() {
    this.blocks = [];
    for (let x = 0; x < GRID; x++) {
      for (let y = 0; y < GRID; y++) {
        this.blocks.push({ x, y, alive: true, fallAt: null });
      }
    }
    this.waterLevel = 0;
    this.tick = 0;
    this.nextBlockFallAt = 6000; // ms into the match before blocks start falling
  }

  blockAt(x, y) {
    return this.blocks.find(b => b.x === x && b.y === y);
  }

  start() {
    if (this.state === 'playing') return;
    this.resetBoard();
    this.state = 'playing';
    this.startedAt = Date.now();
    let i = 0;
    const spawns = [];
    for (let x = 1; x < GRID - 1; x += 2) {
      for (let y = 1; y < GRID - 1; y += 2) {
        spawns.push({ x, y });
      }
    }
    for (const p of this.players.values()) {
      const s = spawns[i % spawns.length] || { x: GRID / 2, y: GRID / 2 };
      i++;
      p.x = s.x;
      p.y = s.y;
      p.alive = true;
      p.fellAt = null;
      p.place = null;
    }
    this.broadcast({ t: 'start', grid: GRID, players: this.publicPlayers() });
    if (this.loop) clearInterval(this.loop);
    this.loop = setInterval(() => this.update(), TICK_MS);
  }

  update() {
    this.tick += TICK_MS;
    const elapsed = this.tick;

    // water rises over time (full flood around 90s)
    this.waterLevel = Math.min(1, elapsed / 90000);

    // periodically drop random alive blocks, faster as time passes
    if (elapsed > this.nextBlockFallAt) {
      const alive = this.blocks.filter(b => b.alive);
      if (alive.length > GRID) {
        const dropCount = 1 + Math.floor(elapsed / 25000);
        for (let k = 0; k < dropCount && alive.length; k++) {
          const b = alive[Math.floor(Math.random() * alive.length)];
          b.alive = false;
          b.fallAt = elapsed;
        }
      }
      const interval = Math.max(600, 2200 - elapsed / 60);
      this.nextBlockFallAt = elapsed + interval;
    }

    // check players: standing on missing block OR water has reached/exceeded their tile => eliminated
    let aliveCount = 0;
    const waterRow = GRID - 1 - Math.floor(this.waterLevel * GRID);
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const b = this.blockAt(p.x, p.y);
      const underwater = p.y >= waterRow; // rows from the "wet edge" inward count as flooded
      if (!b || !b.alive || underwater) {
        p.alive = false;
        p.fellAt = elapsed;
        p.place = this.remainingAliveBeforeThis();
      } else {
        aliveCount++;
      }
    }

    this.broadcast({
      t: 'tick',
      elapsed,
      waterLevel: this.waterLevel,
      waterRow,
      blocks: this.blocks.filter(b => !b.alive).map(b => [b.x, b.y]),
      players: this.publicPlayers(),
    });

    if (aliveCount <= 1 && this.players.size > 0) {
      const alivePlayers = [...this.players.values()].filter(p => p.alive);
      this.state = 'ended';
      this.broadcast({ t: 'end', winner: alivePlayers[0] ? alivePlayers[0].name : null, players: this.publicPlayers() });
      clearInterval(this.loop);
      this.loop = null;
    }
  }

  remainingAliveBeforeThis() {
    return [...this.players.values()].filter(p => p.alive).length;
  }

  publicPlayers() {
    return [...this.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, alive: p.alive,
    }));
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
        x: 1, y: 1, alive: true, fellAt: null, place: null,
      };
      room.players.set(id, player);
      ws.send(JSON.stringify({ t: 'joined', code, id, color, players: room.publicPlayers(), state: room.state, grid: GRID }));
      room.broadcast({ t: 'lobby', players: room.publicPlayers(), code });
      return;
    }

    if (!room || !player) return;

    if (msg.t === 'start') {
      room.start();
      return;
    }

    if (msg.t === 'move' && room.state === 'playing' && player.alive) {
      const dx = { up: 0, down: 0, left: -1, right: 1 }[msg.dir] || 0;
      const dy = { up: -1, down: 1, left: 0, right: 0 }[msg.dir] || 0;
      const nx = Math.max(0, Math.min(GRID - 1, player.x + dx));
      const ny = Math.max(0, Math.min(GRID - 1, player.y + dy));
      player.x = nx;
      player.y = ny;
      return;
    }

    if (msg.t === 'restart') {
      room.start();
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
