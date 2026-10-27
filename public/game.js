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
  const connStatus2El = $('connStatus2');
  const canvasWrap = $('canvasWrap');

  let ws = null;
  let myId = null;
  let roomCode = null;
  let players = [];
  let platforms = [];
  let monster = { x: 0, z: 0, phase: 'lurk', targetId: null };
  let gameState = 'lobby';
  let elapsedMs = 0;

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

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

  function showToast(text, color) {
    toastEl.textContent = text;
    toastEl.style.color = color || '#fff';
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 1400);
  }

  function showResult(winnerName) {
    const me = players.find(p => p.id === myId);
    if (winnerName && me && me.name === winnerName) resultTitleEl.textContent = '🏆 Сен жеңдиң!';
    else if (winnerName) resultTitleEl.textContent = '🏁 Жеңүүчү: ' + winnerName;
    else resultTitleEl.textContent = 'Оюн бүттү';
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

  function handleMessage(msg) {
    if (msg.t === 'joined') {
      myId = msg.id;
      roomCode = msg.code;
      players = msg.players;
      platforms = msg.platforms;
      roomCodeEl.textContent = roomCode;
      history.replaceState(null, '', '?room=' + roomCode);
      renderPlayerList();
      buildArena();
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
      players = msg.players;
      platforms = msg.platforms;
      gameState = 'playing';
      myPos.x = players.find(p => p.id === myId)?.x ?? 0;
      myPos.z = players.find(p => p.id === myId)?.z ?? 0;
      showScreen(gameScreen);
      onResize();
      return;
    }
    if (msg.t === 'tick') {
      elapsedMs = msg.elapsed;
      const prevAlive = new Map(players.map(p => [p.id, p.alive]));
      players = msg.players;
      monster = msg.monster;
      const me = players.find(p => p.id === myId);
      if (me && prevAlive.get(myId) !== false && me.alive === false) {
        showToast('💀 Сени кармап алышты!', '#ff5a5f');
      }
      timerEl.textContent = Math.floor(elapsedMs / 1000) + 'с';
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

  // ---------- Movement input ----------
  const keys = { up: false, down: false, left: false, right: false };
  const myPos = { x: -7, z: -7 };
  const MOVE_SPEED = 5.5;
  const ARENA_HALF = 10;

  function bindHold(el, dir) {
    const down = (e) => { e.preventDefault(); keys[dir] = true; };
    const up = (e) => { e.preventDefault(); keys[dir] = false; };
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('touchend', up, { passive: false });
    el.addEventListener('touchcancel', up, { passive: false });
    el.addEventListener('mousedown', down);
    el.addEventListener('mouseup', up);
    el.addEventListener('mouseleave', up);
  }
  document.querySelectorAll('.dpad button[data-dir]').forEach(btn => bindHold(btn, btn.dataset.dir));

  window.addEventListener('keydown', (e) => {
    const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };
    if (map[e.key]) { keys[map[e.key]] = true; e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => {
    const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };
    if (map[e.key]) { keys[map[e.key]] = false; e.preventDefault(); }
  });

  // ---------- Three.js scene ----------
  let renderer, scene, camera;
  let waterMesh, waterMat;
  let playerMeshes = new Map(); // id -> group
  let monsterGroup, monsterBody;
  let clock = new THREE.Clock();
  let arenaBuilt = false;

  function initThree() {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    canvasWrap.insertBefore(renderer.domElement, canvasWrap.firstChild);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a1628);
    scene.fog = new THREE.Fog(0x0a1628, 18, 40);

    camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);

    const hemi = new THREE.HemisphereLight(0x8fb6ff, 0x101830, 0.9);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(10, 18, 6);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    dir.shadow.camera.left = -16; dir.shadow.camera.right = 16;
    dir.shadow.camera.top = 16; dir.shadow.camera.bottom = -16;
    scene.add(dir);

    onResize();
    window.addEventListener('resize', onResize);
  }

  function onResize() {
    if (!renderer) return;
    const w = canvasWrap.clientWidth || window.innerWidth;
    const h = canvasWrap.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function buildArena() {
    if (arenaBuilt || !platforms.length) return;
    arenaBuilt = true;

    const ARENA = 11;
    const HEIGHT = 9;

    // --- room shell: floor far below, 4 walls, no roof so we can see down ---
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x24344f, roughness: 0.9, metalness: 0.05, side: THREE.BackSide });
    const room = new THREE.Mesh(new THREE.BoxGeometry(ARENA * 2, HEIGHT, ARENA * 2), wallMat);
    room.position.set(0, HEIGHT / 2 - 3, 0);
    room.receiveShadow = true;
    scene.add(room);

    // deep floor (below water) dark
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x0d1322, roughness: 1 });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(ARENA * 2, 0.2, ARENA * 2), floorMat);
    floor.position.set(0, -4, 0);
    scene.add(floor);

    // --- water surface ---
    waterMat = new THREE.MeshStandardMaterial({
      color: 0x1f6fc9, transparent: true, opacity: 0.78, roughness: 0.15, metalness: 0.3,
    });
    waterMesh = new THREE.Mesh(new THREE.PlaneGeometry(ARENA * 2 - 0.4, ARENA * 2 - 0.4, 24, 24), waterMat);
    waterMesh.rotation.x = -Math.PI / 2;
    waterMesh.position.y = -0.15;
    scene.add(waterMesh);

    // --- platforms ---
    const platMat = new THREE.MeshStandardMaterial({ color: 0xd9b36c, roughness: 0.8 });
    const platMatAlt = new THREE.MeshStandardMaterial({ color: 0xc89f58, roughness: 0.8 });
    platforms.forEach((p, i) => {
      const geo = new THREE.BoxGeometry(p.w, 0.5, p.d);
      const mesh = new THREE.Mesh(geo, i % 2 === 0 ? platMat : platMatAlt);
      mesh.position.set(p.x, p.y - 0.25, p.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      // thin edge trim for visibility
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0x5a4523, transparent: true, opacity: 0.5 })
      );
      edges.position.copy(mesh.position);
      scene.add(edges);
    });

    // --- monster (dark humanoid-ish creature) ---
    monsterGroup = new THREE.Group();
    const mBodyMat = new THREE.MeshStandardMaterial({ color: 0x1a0f1f, roughness: 0.6, emissive: 0x3a0a3a, emissiveIntensity: 0.4 });
    const mEyeMat = new THREE.MeshStandardMaterial({ color: 0xff2b2b, emissive: 0xff2b2b, emissiveIntensity: 2 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.7, 4, 8), mBodyMat);
    torso.position.y = 0.55;
    monsterGroup.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 10), mBodyMat);
    head.position.y = 1.15;
    monsterGroup.add(head);
    [-0.14, 0.14].forEach(ex => {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), mEyeMat);
      eye.position.set(ex, 1.18, 0.28);
      monsterGroup.add(eye);
    });
    // spiky tendrils around
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.5, 5), mBodyMat);
      spike.position.set(Math.cos(a) * 0.4, 0.3, Math.sin(a) * 0.4);
      spike.rotation.x = Math.PI / 2.2;
      spike.rotation.z = a;
      monsterGroup.add(spike);
    }
    monsterGroup.visible = false;
    monsterBody = { torso, head };
    scene.add(monsterGroup);

    camera.position.set(0, 13, 15);
    camera.lookAt(0, 0, 0);
  }

  function colorToHex(c) {
    return new THREE.Color(c).getHex();
  }

  function ensurePlayerMesh(p) {
    if (playerMeshes.has(p.id)) return playerMeshes.get(p.id);
    const group = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0xffd9b0, roughness: 0.7 });
    const cloth = new THREE.MeshStandardMaterial({ color: colorToHex(p.color), roughness: 0.6 });

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.55, 4, 8), cloth);
    body.position.y = 0.5;
    body.castShadow = true;
    group.add(body);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 12), skin);
    head.position.y = 1.05;
    head.castShadow = true;
    group.add(head);

    // simple arms
    const armGeo = new THREE.CapsuleGeometry(0.08, 0.4, 4, 6);
    [-1, 1].forEach(side => {
      const arm = new THREE.Mesh(armGeo, cloth);
      arm.position.set(0.4 * side, 0.55, 0);
      arm.rotation.z = side * 0.25;
      group.add(arm);
    });

    // name label via sprite
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const ctx2d = canvas.getContext('2d');
    ctx2d.font = 'bold 36px sans-serif';
    ctx2d.fillStyle = '#ffffff';
    ctx2d.textAlign = 'center';
    ctx2d.shadowColor = 'rgba(0,0,0,0.8)';
    ctx2d.shadowBlur = 6;
    ctx2d.fillText(p.name.slice(0, 14), 128, 44);
    const tex = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(1.4, 0.35, 1);
    sprite.position.y = 1.55;
    group.add(sprite);

    scene.add(group);
    playerMeshes.set(p.id, group);
    return group;
  }

  function removeStaleMeshes() {
    const ids = new Set(players.map(p => p.id));
    for (const [id, mesh] of playerMeshes) {
      if (!ids.has(id)) {
        scene.remove(mesh);
        playerMeshes.delete(id);
      }
    }
  }

  // ---------- Game loop ----------
  let lastSendTime = 0;
  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, clock.getDelta());
    const t = clock.elapsedTime;

    if (gameState === 'playing' && arenaBuilt) {
      // local movement prediction
      let dx = 0, dz = 0;
      if (keys.up) dz -= 1;
      if (keys.down) dz += 1;
      if (keys.left) dx -= 1;
      if (keys.right) dx += 1;
      if (dx || dz) {
        const len = Math.hypot(dx, dz);
        myPos.x += (dx / len) * MOVE_SPEED * dt;
        myPos.z += (dz / len) * MOVE_SPEED * dt;
        myPos.x = Math.max(-ARENA_HALF, Math.min(ARENA_HALF, myPos.x));
        myPos.z = Math.max(-ARENA_HALF, Math.min(ARENA_HALF, myPos.z));
      }
      const now = performance.now();
      if (now - lastSendTime > 40) {
        lastSendTime = now;
        send({ t: 'move', x: myPos.x, z: myPos.z });
      }

      removeStaleMeshes();
      let myAliveState = true;
      players.forEach(p => {
        const mesh = ensurePlayerMesh(p);
        const targetX = p.id === myId ? myPos.x : p.x;
        const targetZ = p.id === myId ? myPos.z : p.z;
        mesh.position.x += (targetX - mesh.position.x) * Math.min(1, dt * 12);
        mesh.position.z += (targetZ - mesh.position.z) * Math.min(1, dt * 12);
        mesh.position.y = p.y + (p.alive ? Math.sin(t * 3 + p.x) * 0.03 : -0.6);
        mesh.visible = true;
        mesh.children.forEach(c => { if (c.material) c.material.opacity = p.alive ? 1 : 0.3; });
        mesh.traverse(c => { if (c.material && c.material.transparent === false && !p.alive) { c.material.transparent = true; } });
        if (p.id === myId) myAliveState = p.alive;
      });

      // monster visual
      if (monster && monster.phase === 'strike' && monster.targetId) {
        monsterGroup.visible = true;
        monsterGroup.position.x += (monster.x - monsterGroup.position.x) * Math.min(1, dt * 14);
        monsterGroup.position.z += (monster.z - monsterGroup.position.z) * Math.min(1, dt * 14);
        monsterGroup.position.y = -0.3 + Math.sin(t * 20) * 0.08;
        monsterGroup.lookAt(monsterGroup.position.x, -0.3, monsterGroup.position.z - 1);
        const target = players.find(pp => pp.id === monster.targetId);
        if (target) monsterGroup.lookAt(target.x, -0.3, target.z);
      } else {
        monsterGroup.position.x += (monster.x - monsterGroup.position.x) * Math.min(1, dt * 3);
        monsterGroup.position.z += (monster.z - monsterGroup.position.z) * Math.min(1, dt * 3);
        monsterGroup.position.y = -1.4 + Math.sin(t * 1.5) * 0.15;
        monsterGroup.visible = monsterGroup.position.y > -1.9;
      }

      // water animation
      if (waterMesh) {
        const pos = waterMesh.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), y0 = pos.getY(i);
          const wave = Math.sin(x * 0.6 + t * 1.6) * 0.06 + Math.cos(y0 * 0.5 + t * 1.2) * 0.05;
          pos.setZ(i, wave);
        }
        pos.needsUpdate = true;
        waterMesh.geometry.computeVertexNormals();
      }

      // camera: follow my player from above at an angle
      const me = players.find(p => p.id === myId);
      const followX = me ? (p => p)(myPos.x) : 0;
      const followZ = me ? myPos.z : 0;
      const camTarget = new THREE.Vector3(followX * 0.4, 0, followZ * 0.4 + 4);
      const desired = new THREE.Vector3(followX * 0.3, 12, followZ * 0.5 + 11);
      camera.position.lerp(desired, Math.min(1, dt * 2.2));
      camera.lookAt(followX * 0.3, -0.5, followZ * 0.3);
    }

    if (renderer && scene && camera) renderer.render(scene, camera);
  }

  initThree();
  requestAnimationFrame(animate);
})();
