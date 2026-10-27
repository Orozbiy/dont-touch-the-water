# Don't Touch The Water 💧

Multiplayer browser survival game inspired by the "water is rising, don't touch the water" Roblox genre: platform tiles randomly collapse and the water level keeps rising — last player standing wins.

## How it works

- **Server**: Node.js + Express + `ws` (WebSocket). Authoritative game loop — tracks rooms, player positions, which tiles have collapsed, and the current water level, then broadcasts state ~20 times/sec to everyone in the room.
- **Client**: Plain HTML/CSS/JS, isometric canvas renderer, touch D-pad + swipe + arrow-key controls. No build step.

## Play with friends

1. Open the deployed URL.
2. Enter your name, leave the room code blank to create a new room (or type a friend's code to join them).
3. Share the 5-letter room code — friends open the same URL and type it in.
4. Once everyone has joined, anyone in the lobby can tap **Оюнду баштоо** (Start) to begin.
5. Move with the on-screen arrows (or WASD / arrow keys). Avoid tiles that collapse and stay ahead of the rising water. Last player alive wins.

## Run locally

```bash
npm install
npm start
# open http://localhost:8080
```

## Deploy (Render.com, free tier)

1. Push this repo to GitHub.
2. On Render: **New → Web Service** → connect this repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Render auto-detects the port via `process.env.PORT` — no extra config needed.
6. Once deployed, share the `https://<your-app>.onrender.com` URL with friends.

Note: Render's free tier spins down after inactivity, so the first request after idling may take ~30-60s to wake up.
