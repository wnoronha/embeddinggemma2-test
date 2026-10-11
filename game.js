// Road and Game Configuration
const ROAD_CONFIG = {
  lanes: 3,
  roadPadding: 20,
  carWidth: 38,
  carHeight: 68,
  speed: 1.0, // Smooth cruising speed
  dashLength: 24,
  dashGap: 24,
};

class CarGame {
  constructor() {
    this.canvas = document.getElementById("roadCanvas");
    this.canvas.width = 280;
    this.canvas.height = 460;
    this.ctx = this.canvas.getContext("2d");

    this.width = this.canvas.width;
    this.height = this.canvas.height;
    this.laneWidth = (this.width - ROAD_CONFIG.roadPadding * 2) / ROAD_CONFIG.lanes;

    // Game state
    this.isPaused = false;
    this.isCrashed = false;
    this.crashParticles = [];
    this.roadOffsetY = 0;
    this.currentLane = 2; // 1-indexed (1, 2, 3)
    this.targetLane = 2;
    this.carX = this.getLaneCenterX(2);
    this.carY = this.height - 85;
    this.targetX = this.carX;
    
    // Initial state: NO barriers on page load
    this.obstacles = [];

    // Evaluation throttling
    this.lastDecisionTime = 0;
    this.decisionCooldown = 1000; // ms
    this.isEvaluating = false;
    this._evalSeq = 0;

    // Real-model state (no probabilities anywhere: model returns a lane only)
    this.aiEngine = "loading"; // loading | decisionmaker | textembedder | failed
    this.lastSimilarities = null;

    // DOM Elements
    this.pauseBtn = document.getElementById("pauseBtn");
    this.manualTriggerBtn = document.getElementById("manualTriggerBtn");
    this.jsonPayloadPreview = document.getElementById("jsonPayloadPreview");
    this.currentLaneDisplay = document.getElementById("currentLaneDisplay");
    this.aiDecisionDisplay = document.getElementById("aiDecisionDisplay");
    this.latencyDisplay = document.getElementById("latencyDisplay");
    this.engineDisplay = document.getElementById("engineDisplay");
    this.simsDisplay = document.getElementById("simsDisplay");
    this.debugDisplay = document.getElementById("debugDisplay");

    // Initial setup
    this.bindEvents();
    this.updateCurrentLaneUI();
    this.updatePayloadPreview();
    this.listenForEngine();

    // Start loop
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  getLaneCenterX(laneNumber) {
    const laneIndex = laneNumber - 1;
    return ROAD_CONFIG.roadPadding + laneIndex * this.laneWidth + this.laneWidth / 2;
  }

  bindEvents() {
    if (this.pauseBtn) {
      this.pauseBtn.addEventListener("click", () => {
        if (this.isCrashed) {
          this.resetGame();
          return;
        }
        this.isPaused = !this.isPaused;
        this.pauseBtn.textContent = this.isPaused ? "Resume animation" : "Pause animation";
      });
    }

    if (this.manualTriggerBtn) {
      this.manualTriggerBtn.addEventListener("click", () => this.evaluateDecisions(true));
    }
  }

  resetGame() {
    this.isCrashed = false;
    this.isPaused = false;
    this.crashParticles = [];
    this.carX = this.getLaneCenterX(this.targetLane);
    if (this.pauseBtn) this.pauseBtn.textContent = "Pause animation";
    if (this.aiDecisionDisplay) {
      this.aiDecisionDisplay.textContent = `Lane ${this.currentLane}`;
      this.aiDecisionDisplay.style.color = "#38bdf8";
    }
  }

  spawnSingleObstacle(lane) {
    if (this.isCrashed) this.resetGame();

    const existingIndex = this.obstacles.findIndex(o => o.lane === lane);
    if (existingIndex !== -1) {
      // Toggle off: remove obstacle
      this.obstacles.splice(existingIndex, 1);
    } else {
      // Toggle on: spawn obstacle
      this.obstacles.push({
        id: Date.now() + Math.random(),
        lane: lane,
        y: -20,
        width: this.laneWidth - 14,
        height: 24
      });
    }

    this.updateButtonStates();
    this.updatePayloadPreview();
    this.evaluateDecisions(true);
  }

  updateButtonStates() {
    const blockedLanes = new Set(this.obstacles.map(o => o.lane));
    for (let l = 1; l <= 3; l++) {
      const btn = document.getElementById(`blockBtn${l}`);
      if (btn) {
        if (blockedLanes.has(l)) {
          btn.classList.add("active");
        } else {
          btn.classList.remove("active");
        }
      }
    }
  }

  spawnRandomObstacles(count) {
    if (this.isCrashed) this.resetGame();
    this.obstacles = [];
    this.randomObstacleCount = count; // Track active random mode
    const allLanes = [1, 2, 3];
    const shuffled = allLanes.sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, count);

    selected.forEach(lane => {
      this.obstacles.push({
        id: Date.now() + Math.random(),
        lane: lane,
        y: -20,
        width: this.laneWidth - 14,
        height: 24,
        isRandom: true
      });
    });

    this.updateButtonStates();
    this.updatePayloadPreview();
    this.evaluateDecisions(true);
  }

  clearAllObstacles() {
    this.obstacles = [];
    this.randomObstacleCount = 0;
    if (this.isCrashed) this.resetGame();
    this.updateButtonStates();
    this.updatePayloadPreview();
    this.evaluateDecisions(true);
  }

  getDecisionPayload() {
    const incomingObstacles = this.obstacles.filter(o => o.y < this.carY + 40 && o.y > -40);
    const blockedLanes = new Set(incomingObstacles.map(o => o.lane));

    const choices = [1, 2, 3].map(lane => {
      const isBlocked = blockedLanes.has(lane);
      return {
        value: `lane_${lane}`,
        description: isBlocked
          ? `Lane ${lane} is blocked by a dangerous roadblock barrier`
          : `Lane ${lane} is completely clear with unobstructed open road`
      };
    });

    return {
      model: "mediapipe-decisionmaker/embeddinggemma-2-270M (fallback: mediapipe-textembedder/embeddinggemma-300M)",
      query: "Completely clear with unobstructed open road",
      questions: [
        {
          type: "choice",
          name: "lane_choice",
          instructions: "Identify the safest lane that is clear of roadblocks.",
          choices: choices
        }
      ]
    };
  }

  updatePayloadPreview() {
    const payload = this.getDecisionPayload();
    if (this.jsonPayloadPreview) {
      this.jsonPayloadPreview.textContent = JSON.stringify(payload, null, 2);
    }
  }

  listenForEngine() {
    window.addEventListener("decision-engine-status", (e) => {
      const s = e.detail || {};
      if (s.status === "ready-decision") this.aiEngine = "decisionmaker";
      else if (s.status === "ready-embed") this.aiEngine = "textembedder";
      else if (s.status === "failed") this.aiEngine = "failed";
      else this.aiEngine = "loading";
      this.renderEngineLine();
      // Re-evaluate immediately once the real model becomes ready.
      if ((s.status === "ready-decision" || s.status === "ready-embed")) {
        this.evaluateDecisions(true);
      }
    });
    this.renderEngineLine();
  }

  renderEngineLine() {
    if (this.engineDisplay) {
      if (this.aiEngine === "decisionmaker") this.engineDisplay.textContent = "DecisionMaker + EmbeddingGemma2-270M";
      else if (this.aiEngine === "textembedder") this.engineDisplay.textContent = "TextEmbedder + EmbeddingGemma-300M";
      else if (this.aiEngine === "failed") this.engineDisplay.textContent = "model failed — car holding lane";
      else this.engineDisplay.textContent = "loading model…";
    }
  }

  // Car steers ONLY from a real model result. No heuristic, no probabilities.
  applyModelDecision(chosen, opts = {}) {
    this.lastSimilarities = opts.similarities || null;
    this.targetLane = chosen;
    this.targetX = this.getLaneCenterX(chosen);

    if (this.latencyDisplay) this.latencyDisplay.textContent = `${opts.latencyMs ?? 0} ms`;
    if (this.aiDecisionDisplay) {
      this.aiDecisionDisplay.textContent = `Steer Lane ${chosen} (AI)`;
    }
    this.renderDebugLine(opts);
    this.lastDecisionTime = performance.now();
  }

  // No steering here: road clear / trapped / model not ready. Car holds lane.
  applyHoldState(text, opts = {}) {
    if (this.latencyDisplay && opts.latencyMs != null) this.latencyDisplay.textContent = `${opts.latencyMs} ms`;
    if (this.aiDecisionDisplay) this.aiDecisionDisplay.textContent = text;
    this.renderDebugLine(opts);
    this.lastDecisionTime = performance.now();
  }

  renderDebugLine(opts = {}) {
    if (this.debugDisplay) {
      const sims = opts.similarities
        ? ` sims=[${[1, 2, 3].map(l => (opts.similarities[l] ?? 0).toFixed(3)).join(", ")}]`
        : "";
      this.debugDisplay.textContent =
        `engine=${opts.engine || this.aiEngine}${sims} ${opts.latencyMs ?? 0}ms`;
    }
    if (this.simsDisplay) {
      this.simsDisplay.textContent = opts.similarities
        ? [1, 2, 3].map(l => `L${l} ${(opts.similarities[l] ?? 0).toFixed(3)}`).join("  ")
        : "sims: n/a (DecisionMaker scores internally)";
    }
  }

  async evaluateDecisions(force = false) {
    if (this.isEvaluating && !force) return;
    if (this.isCrashed) return;

    this.isEvaluating = true;
    const seq = ++this._evalSeq;
    try {
      const payload = this.getDecisionPayload();
      const activeBarriers = this.obstacles.filter(o => o.y < this.carY + 30 && o.y > -50);
      const blockedLanes = new Set(activeBarriers.map(o => o.lane));
      const openLanes = [1, 2, 3].filter(l => !blockedLanes.has(l));

      // No decision needed: road clear -> cruise, hold lane. No model call.
      if (blockedLanes.size === 0) {
        this.applyHoldState("Cruising Clear", { engine: this.aiEngine });
        return;
      }
      // No escape: all lanes blocked -> hold lane, show Trapped. No model call.
      if (openLanes.length === 0) {
        this.applyHoldState("Warning: Trapped!", { engine: this.aiEngine });
        return;
      }

      const DE = window.DecisionEngine;
      if (!(DE && DE.isModelReady())) {
        // Model not loaded: DO NOT steer. Car holds its lane.
        this.applyHoldState("Waiting for model…", { engine: this.aiEngine });
        return;
      }

      try {
        const t0 = performance.now();
        const res = await DE.evaluateLaneChoice(payload);
        if (seq !== this._evalSeq) return; // stale: a newer evaluation won
        const wallMs = Math.round(performance.now() - t0);

        this.aiEngine = res.engine.includes("decisionmaker")
          ? "decisionmaker" : "textembedder";
        this.renderEngineLine();
        // Follow the model strictly (even if it picks a blocked lane: visible error, honest).
        this.applyModelDecision(res.chosen, {
          similarities: res.similarities,
          latencyMs: res.latencyMs ?? wallMs,
          engine: res.engine,
        });
      } catch (err) {
        console.warn("[game] model inference failed, holding lane:", err);
        this.applyHoldState("Model error — holding lane", { engine: this.aiEngine });
      }
    } finally {
      this.isEvaluating = false;
    }
  }

  updateCurrentLaneUI() {
    if (this.currentLaneDisplay) {
      this.currentLaneDisplay.textContent = `Lane ${this.currentLane}`;
    }
  }

  triggerCrash(obstacle) {
    this.isCrashed = true;
    this.isPaused = true;
    if (this.pauseBtn) this.pauseBtn.textContent = "Restart after Crash";
    if (this.aiDecisionDisplay) {
      this.aiDecisionDisplay.textContent = "CRASH DETECTED!";
      this.aiDecisionDisplay.style.color = "#ef4444";
    }

    this.crashParticles = [];
    for (let i = 0; i < 28; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.5 + Math.random() * 4;
      this.crashParticles.push({
        x: this.carX,
        y: this.carY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 3 + Math.random() * 5,
        color: ['#ef4444', '#f97316', '#fbbf24', '#ffffff'][Math.floor(Math.random() * 4)],
        life: 1.0,
      });
    }
  }

  updatePhysics() {
    if (this.isCrashed) {
      for (const p of this.crashParticles) {
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.03;
      }
      this.crashParticles = this.crashParticles.filter(p => p.life > 0);
      return;
    }

    if (this.isPaused) return;

    // Scroll road markings
    this.roadOffsetY = (this.roadOffsetY + ROAD_CONFIG.speed) % (ROAD_CONFIG.dashLength + ROAD_CONFIG.dashGap);

    // Move obstacles downward
    for (let obs of this.obstacles) {
      obs.y += ROAD_CONFIG.speed;

      // Collision Detection
      const carLeft = this.carX - ROAD_CONFIG.carWidth / 2 + 4;
      const carRight = this.carX + ROAD_CONFIG.carWidth / 2 - 4;
      const carTop = this.carY - ROAD_CONFIG.carHeight / 2 + 4;
      const carBottom = this.carY + ROAD_CONFIG.carHeight / 2 - 4;

      const obsX = this.getLaneCenterX(obs.lane) - obs.width / 2;
      const obsRight = obsX + obs.width;
      const obsBottom = obs.y + obs.height;

      if (carRight > obsX && carLeft < obsRight && carBottom > obs.y && carTop < obsBottom) {
        this.triggerCrash(obs);
        return;
      }

      // Loop obstacles back to top if offscreen
      if (obs.y > this.height + 40) {
        obs.y = -30;

        // If in random mode, re-roll lanes randomly across 1, 2, 3
        if (obs.isRandom) {
          const usedLanes = new Set(this.obstacles.filter(o => o !== obs && o.y < 50).map(o => o.lane));
          const available = [1, 2, 3].filter(l => !usedLanes.has(l));
          if (available.length > 0) {
            obs.lane = available[Math.floor(Math.random() * available.length)];
          }
          this.updateButtonStates();
          this.updatePayloadPreview();
        }
      }
    }

    // Steer car smoothly towards targetLane (fast and crisp responsiveness)
    const dx = this.targetX - this.carX;
    this.carX += dx * 0.16;

    // Update current lane
    const relX = this.carX - ROAD_CONFIG.roadPadding;
    const laneEst = Math.max(1, Math.min(3, Math.floor(relX / this.laneWidth) + 1));
    if (laneEst !== this.currentLane) {
      this.currentLane = laneEst;
      if (this.currentLaneDisplay) {
        this.currentLaneDisplay.textContent = `Lane ${this.currentLane}`;
      }
      this.updatePayloadPreview();
    }

    // Check decisions regularly as barriers scroll
    const now = performance.now();
    if (now - this.lastDecisionTime > this.decisionCooldown) {
      this.evaluateDecisions();
    }
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    // 1. Draw Road Background
    ctx.fillStyle = "#13171f";
    ctx.fillRect(ROAD_CONFIG.roadPadding, 0, this.width - ROAD_CONFIG.roadPadding * 2, this.height);

    // Road borders
    ctx.strokeStyle = "#242a36";
    ctx.lineWidth = 3;
    ctx.strokeRect(ROAD_CONFIG.roadPadding, 0, this.width - ROAD_CONFIG.roadPadding * 2, this.height);

    // 2. Lane Numbers (1, 2, 3)
    ctx.font = "12px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    ctx.fillStyle = "#6e7681";
    ctx.textAlign = "center";
    for (let i = 1; i <= ROAD_CONFIG.lanes; i++) {
      const centerX = this.getLaneCenterX(i);
      ctx.fillText(`${i}`, centerX, 24);
    }

    // 3. Lane Dividers
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.lineWidth = 2.5;
    ctx.setLineDash([ROAD_CONFIG.dashLength, ROAD_CONFIG.dashGap]);
    ctx.lineDashOffset = -this.roadOffsetY;

    for (let i = 1; i < ROAD_CONFIG.lanes; i++) {
      const dividerX = ROAD_CONFIG.roadPadding + i * this.laneWidth;
      ctx.beginPath();
      ctx.moveTo(dividerX, 32);
      ctx.lineTo(dividerX, this.height);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // 4. Draw Obstacles (Barriers)
    for (const obs of this.obstacles) {
      const obsX = this.getLaneCenterX(obs.lane) - obs.width / 2;
      this.drawBarrier(ctx, obsX, obs.y, obs.width, obs.height);
    }

    // 5. Draw Car or Crash
    if (this.isCrashed) {
      this.drawCrashedCar(ctx, this.carX, this.carY, ROAD_CONFIG.carWidth, ROAD_CONFIG.carHeight);
      for (const p of this.crashParticles) {
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.life;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1.0;
    } else {
      this.drawCar(ctx, this.carX, this.carY, ROAD_CONFIG.carWidth, ROAD_CONFIG.carHeight);
    }
  }

  drawBarrier(ctx, x, y, w, h) {
    ctx.save();
    ctx.fillStyle = "#475569";
    ctx.fillRect(x + 4, y + h - 4, 8, 8);
    ctx.fillRect(x + w - 12, y + h - 4, 8, 8);

    ctx.fillStyle = "#fb923c";
    ctx.beginPath();
    ctx.roundRect(x, y, w, h - 2, 4);
    ctx.fill();

    ctx.save();
    ctx.clip();
    ctx.fillStyle = "#ffffff";
    const stripeWidth = 10;
    for (let sx = -h; sx < w + h; sx += stripeWidth * 2) {
      ctx.beginPath();
      ctx.moveTo(x + sx, y);
      ctx.lineTo(x + sx + stripeWidth, y);
      ctx.lineTo(x + sx + stripeWidth - h, y + h);
      ctx.lineTo(x + sx - h, y + h);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    ctx.strokeStyle = "#c2410c";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h - 2);
    ctx.restore();
  }

  drawCar(ctx, centerX, centerY, w, h) {
    ctx.save();
    const x = centerX - w / 2;
    const y = centerY - h / 2;

    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.beginPath();
    ctx.roundRect(x + 2, y + 4, w, h, 8);
    ctx.fill();

    ctx.fillStyle = "#60a5fa";
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 10);
    ctx.fill();

    ctx.fillStyle = "#3b82f6";
    ctx.beginPath();
    ctx.roundRect(x + 3, y + 14, w - 6, h - 26, 6);
    ctx.fill();

    ctx.fillStyle = "#1e293b";
    ctx.beginPath();
    ctx.roundRect(x + 6, y + 15, w - 12, 12, 4);
    ctx.fill();

    ctx.beginPath();
    ctx.roundRect(x + 6, y + h - 24, w - 12, 8, 3);
    ctx.fill();

    ctx.fillStyle = "#60a5fa";
    ctx.fillRect(x - 3, y + 20, 3, 7);
    ctx.fillRect(x + w, y + 20, 3, 7);

    ctx.fillStyle = "#fef08a";
    ctx.fillRect(x + 5, y + 2, 6, 3);
    ctx.fillRect(x + w - 11, y + 2, 6, 3);

    ctx.fillStyle = "#ef4444";
    ctx.fillRect(x + 5, y + h - 4, 6, 3);
    ctx.fillRect(x + w - 11, y + h - 4, 6, 3);

    ctx.restore();
  }

  drawCrashedCar(ctx, centerX, centerY, w, h) {
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(0.25);
    const x = -w / 2;
    const y = -h / 2;

    ctx.fillStyle = "#7f1d1d";
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 8);
    ctx.fill();

    ctx.fillStyle = "#450a0a";
    ctx.beginPath();
    ctx.roundRect(x + 3, y + 12, w - 6, h - 24, 6);
    ctx.fill();

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + 10, y + 16);
    ctx.lineTo(x + 24, y + 26);
    ctx.lineTo(x + 14, y + 32);
    ctx.stroke();

    ctx.restore();
  }

  animate() {
    this.updatePhysics();
    this.draw();
    requestAnimationFrame(this.animate);
  }
}

// Global button handlers
let gameInstance = null;
window.addEventListener("DOMContentLoaded", () => {
  gameInstance = new CarGame();
});

window.spawnObstacle = (lane) => {
  if (gameInstance) gameInstance.spawnSingleObstacle(lane);
};

window.spawnRandomObstacles = (count) => {
  if (gameInstance) gameInstance.spawnRandomObstacles(count);
};

window.clearObstacles = () => {
  if (gameInstance) gameInstance.clearAllObstacles();
};
