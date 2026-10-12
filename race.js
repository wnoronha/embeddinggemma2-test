// Race mode: 3 providers x 1 car each x 3 lanes per car.
// Fair-race rule: RaceController owns the canonical obstacle lanes and mirrors
// them to every track. Decisions fan out in parallel via Promise.allSettled.
// Keys live in localStorage (browser only).

(function () {
  "use strict";

  var LS = { jevKey: "racer.key.jev", jevModel: "racer.model.jev", oaiKey: "racer.key.openai", oaiModel: "racer.model.openai", orKey: "racer.key.openrouter", orModel: "racer.model.openrouter" };

  function loadLS(k, fb) {
    try {
      var v = localStorage.getItem(k);
      return v == null || v === "" ? fb : v;
    } catch (e) { return fb; }
  }
  function saveLS(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { /* private mode */ }
  }

  function $(id) { return document.getElementById(id); }

  var controller = {
    tracks: [],
    canonicalLanes: [],
    isRandom: false,
    stats: {},
    // Self-running race: crashed cars auto-recover and fresh waves spawn so the
    // grid never goes static. Toggle with the "Auto race" button (default on).
    autoRace: true,
    lastWaveAt: 0,
    WAVE_MS: 7000,
    CRASH_RESET_MS: 3000,
  };

  function statsFor(id) {
    if (!controller.stats[id]) controller.stats[id] = { calls: 0, errors: 0, latencies: [], crashes: 0, wins: 0 };
    return controller.stats[id];
  }

  function avg(a) {
    if (!a.length) return 0;
    return Math.round(a.reduce(function (s, x) { return s + x; }, 0) / a.length);
  }

  function renderLeaderboard() {
    var el = $("leaderboard");
    if (!el) return;
    var rows = controller.tracks.map(function (t) {
      var s = statsFor(t.provider.id);
      return {
        label: t.provider.label,
        id: t.provider.id,
        calls: s.calls,
        errors: s.errors,
        avgMs: avg(s.latencies),
        lastMs: t.lastMs || 0,
        crashes: s.crashes,
        state: t.game.isCrashed ? "CRASHED" : (t.game.isPaused ? "paused" : "racing"),
      };
    });
    el.innerHTML = rows.map(function (r) {
      return `<div class="lb-row"><span class="lb-name">${r.label}</span>` +
        `<span class="lb-cell">${r.state}</span>` +
        `<span class="lb-cell">calls ${r.calls}</span>` +
        `<span class="lb-cell">err ${r.errors}</span>` +
        `<span class="lb-cell">avg ${r.avgMs}ms</span>` +
        `<span class="lb-cell">last ${r.lastMs}ms</span>` +
        `<span class="lb-cell">crashes ${r.crashes}</span></div>`;
    }).join("");
  }

  // Build provider objects from current key/model inputs.
  function makeProviders() {
    var RP = window.RaceProviders;
    return [
      {
        id: "local",
        label: "Local EmbeddingGemma",
        needsKey: false,
        decide: async function (laneState) {
          var DE = window.DecisionEngine;
          if (!(DE && DE.isModelReady())) throw new Error("local model loading…");
          var payload = RP.payloadForLocalEngine(laneState);
          return DE.evaluateLaneChoice(payload);
        },
      },
      {
        id: "jev",
        label: "Jev SystemOne",
        needsKey: true,
        decide: function (laneState) {
          return RP.jevDecide(laneState, {
            apiKey: $("key-jev").value,
            model: $("model-jev").value || "jev-latest",
          });
        },
      },
      {
        id: "openai",
        label: "OpenAI Decisions",
        needsKey: true,
        decide: function (laneState) {
          return RP.openaiDecide(laneState, {
            apiKey: $("key-openai").value,
            model: $("model-openai").value || "gpt-6-luna",
          });
        },
      },
      {
        id: "openrouter",
        label: "Jev via OpenRouter",
        needsKey: true,
        decide: function (laneState) {
          return RP.openrouterDecide(laneState, {
            apiKey: $("key-openrouter").value,
            model: $("model-openrouter").value || "typesafe/jev-router",
          });
        },
      },
    ];
  }

  function activeBlockedLanes() {
    // Canonical lanes filtered to those still threatening (mirror of game.js window).
    // Tracks share speed, so sampling track 0 is representative.
    var t0 = controller.tracks[0];
    if (!t0) return controller.canonicalLanes.slice();
    var carY = t0.game.carY;
    var live = t0.game.obstacles
      .filter(function (o) { return o.y < carY + 30 && o.y > -50; })
      .map(function (o) { return o.lane; });
    return [...new Set(live)];
  }

  // Parallel fan-out: one shared laneState, N provider calls, all settle.
  async function evaluateAll(force) {
    if (!controller.tracks.length) return;
    var RP = window.RaceProviders;
    var blocked = activeBlockedLanes();
    if (blocked.length === 0 || blocked.length === 3) {
      // Hold states need no model call; still update each HUD.
      controller.tracks.forEach(function (t) { t.game.evaluateDecisions(true, null); });
      renderLeaderboard();
      return;
    }    var shared = RP.buildLaneState(blocked, null);
    var withCurrent = controller.tracks.map(function (t) {
      var s = Object.assign({}, shared, {
        stateObj: Object.assign({}, shared.stateObj, { currentLane: t.game.currentLane }),
      });
      return { track: t, state: s };
    });
    var started = performance.now();
    var results = await Promise.allSettled(withCurrent.map(function (w) {
      return w.track.game.evaluateDecisions(force !== false, w.state);
    }));
    void results;
    void started;
    renderLeaderboard();
  }

  function mirrorToAll() {
    controller.tracks.forEach(function (t) {
      t.game.setObstacles(controller.canonicalLanes, { isRandom: controller.isRandom });
    });
    updatePayloadCard();
    evaluateAll(true);
  }

  function updatePayloadCard() {
    var el = $("jsonPayloadPreview");
    if (!el || !window.RaceProviders) return;
    var blocked = controller.tracks.length ? activeBlockedLanes() : controller.canonicalLanes.slice();
    var st = window.RaceProviders.buildLaneState(blocked, null);
    el.textContent = JSON.stringify({
      state: st.stateObj,
      model: "jev-latest",
      questions: { lane_choice: { type: "choice", instructions: st.instructions, criteria: st.criteria } },
      _fanout: "same state -> jev + openai-decisions + openrouter(jev-router) + local in parallel (Promise.allSettled)",
      _openai_note: "openai uses native POST /v1/decisions (gpt-6-luna choice); jev uses POST /v1/systemone via /api/jev proxy",
    }, null, 2);
  }

  function stampWave() {
    controller.lastWaveAt = performance.now();
  }

  // True when the current wave no longer threatens: nothing spawned, or every
  // obstacle on the reference track has passed below the cars.
  function waveCleared() {
    var t0 = controller.tracks[0];
    if (!t0) return true;
    if (!t0.game.obstacles.length) return true;
    return t0.game.obstacles.every(function (o) { return o.y > t0.game.carY + 80; });
  }

  // Recover one crashed car without touching the others: push barriers
  // overlapping the car back up (else it re-crashes on the next frame) and
  // restart. Canonical lanes are untouched, so the wave stays mirrored.
  function autoResetTrack(t) {
    var g = t.game;
    g.obstacles.forEach(function (o) {
      if (Math.abs(o.y - g.carY) < 80) o.y -= 160;
    });
    g.resetGame();
  }

  // 1s housekeeping tick: crash recovery + fresh waves when autoRace is on.
  // Respects a deliberate user pause (all paused, none crashed).
  function tick() {
    if (!controller.tracks.length || !controller.autoRace) return;
    var now = performance.now();
    var anyCrashed = controller.tracks.some(function (t) { return t.game.isCrashed; });
    var userPaused = !anyCrashed && controller.tracks.every(function (t) { return t.game.isPaused; });
    controller.tracks.forEach(function (t) {
      if (t.game.isCrashed && now - (t.game.crashedAt || 0) > controller.CRASH_RESET_MS) {
        autoResetTrack(t);
      }
    });
    if (!controller.tracks.some(function (t) { return t.game.isCrashed; })) {
      var pb = $("pauseBtn");
      if (pb && pb.textContent === "Restart after Crash") pb.textContent = "Pause race";
    }
    if (!userPaused && now - controller.lastWaveAt > controller.WAVE_MS && waveCleared()) {
      spawnRandom(Math.random() < 0.5 ? 1 : 2);
    }
    renderLeaderboard();
  }

  function spawnLane(lane) {
    resetCrashes();
    var i = controller.canonicalLanes.indexOf(lane);
    if (i !== -1) controller.canonicalLanes.splice(i, 1);
    else controller.canonicalLanes.push(lane);
    controller.isRandom = false;
    syncBlockButtons();
    stampWave();
    mirrorToAll();
  }

  function spawnRandom(count) {
    resetCrashes();
    var all = [1, 2, 3].sort(function () { return 0.5 - Math.random(); });
    controller.canonicalLanes = all.slice(0, count);
    controller.isRandom = true; // loops same lanes (fair: no per-track divergent re-roll)
    syncBlockButtons();
    stampWave();
    mirrorToAll();
  }

  function clearRoad() {
    controller.canonicalLanes = [];
    controller.isRandom = false;
    resetCrashes();
    syncBlockButtons();
    stampWave();
    mirrorToAll();
  }

  function resetCrashes() {
    controller.tracks.forEach(function (t) {
      if (t.game.isCrashed) t.game.resetGame();
    });
    var pb = $("pauseBtn");
    if (pb) pb.textContent = "Pause race";
  }

  function syncBlockButtons() {
    var set = new Set(controller.canonicalLanes);
    [1, 2, 3].forEach(function (l) {
      var b = $("blockBtn" + l);
      if (b) b.classList.toggle("active", set.has(l));
    });
  }

  function setPaused(paused) {
    controller.tracks.forEach(function (t) { t.game.isPaused = paused; });
    var b = $("pauseBtn");
    if (b) b.textContent = paused ? "Resume race" : "Pause race";
  }

  function boot() {
    if (!$("canvas-local")) return; // not race page
    // Restore keys/models.
    $("key-jev").value = loadLS(LS.jevKey, "");
    $("model-jev").value = loadLS(LS.jevModel, "jev-latest");
    $("key-openai").value = loadLS(LS.oaiKey, "");
    $("model-openai").value = loadLS(LS.oaiModel, "gpt-6-luna");
    $("key-openrouter").value = loadLS(LS.orKey, "");
    $("model-openrouter").value = loadLS(LS.orModel, "typesafe/jev-router");
    [["key-jev", LS.jevKey], ["model-jev", LS.jevModel], ["key-openai", LS.oaiKey], ["model-openai", LS.oaiModel], ["key-openrouter", LS.orKey], ["model-openrouter", LS.orModel]]
      .forEach(function ([id, k]) {
        $(id).addEventListener("input", function (e) { saveLS(k, e.target.value); });
      });

    var providers = makeProviders();
    var defs = [
      { canvasId: "canvas-local", prefix: "local-" },
      { canvasId: "canvas-jev", prefix: "jev-" },
      { canvasId: "canvas-openai", prefix: "openai-" },
      { canvasId: "canvas-openrouter", prefix: "openrouter-" },
    ];
    controller.tracks = providers.map(function (p, i) {
      var game = new window.CarGame({
        canvasId: defs[i].canvasId,
        idPrefix: defs[i].prefix,
        provider: p,
        onDecision: function (res, err) {
          var s = statsFor(p.id);
          if (err) { s.errors++; }
          else if (res) {
            s.calls++;
            if (res.latencyMs != null) {
              s.latencies.push(res.latencyMs);
              if (s.latencies.length > 20) s.latencies.shift();
            }
          }
          var tr = controller.tracks.find(function (x) { return x.provider.id === p.id; });
          if (tr) tr.lastMs = res && res.latencyMs != null ? res.latencyMs : tr.lastMs;
          renderLeaderboard();
        },
      });
      // Crash counting: wrap triggerCrash once.
      var origCrash = game.triggerCrash.bind(game);
      game.triggerCrash = function (obs) {
        statsFor(p.id).crashes++;
        game.crashedAt = performance.now();
        origCrash(obs);
        var pb = $("pauseBtn");
        if (pb) pb.textContent = "Restart after Crash";
        renderLeaderboard();
      };
      return { provider: p, game: game, lastMs: 0 };
    });

    // Slow down remote-track decision cooldown slightly (LLM latency).
    controller.tracks.forEach(function (t) { t.game.decisionCooldown = 1500; });

    // Wire global controls.
    $("pauseBtn").addEventListener("click", function () {
      // If any crashed, restart instead.
      if (controller.tracks.some(function (t) { return t.game.isCrashed; })) {
        resetCrashes();
        setPaused(false);
        return;
      }
      var paused = controller.tracks[0] ? controller.tracks[0].game.isPaused : false;
      setPaused(!paused);
    });
    $("manualTriggerBtn").addEventListener("click", function () { evaluateAll(true); });
    var autoBtn = $("autoBtn");
    if (autoBtn) {
      autoBtn.addEventListener("click", function () {
        controller.autoRace = !controller.autoRace;
        autoBtn.textContent = controller.autoRace ? "Auto race: on" : "Auto race: off";
        autoBtn.classList.toggle("active", controller.autoRace);
        if (controller.autoRace) stampWave();
      });
    }
    window.raceSpawn = spawnLane;
    window.raceRandom = spawnRandom;
    window.raceClear = clearRoad;

    // Re-evaluate when local model becomes ready.
    window.addEventListener("decision-engine-status", function () { evaluateAll(true); });

    // Race cadence: parallel fan-out every 2.5s (force=false → busy tracks skip).
    // Spawns/mirror use force=true for immediate reaction.
    setInterval(function () {
      if (controller.canonicalLanes.length) evaluateAll(false);
    }, 2500);

    // Housekeeping: crash recovery + auto waves. Kick off an opening wave so
    // the grid moves on load with zero clicks.
    setInterval(tick, 1000);
    spawnRandom(2);

    // Periodic re-eval (each track also self-throttles in updatePhysics).
    setInterval(function () { updatePayloadCard(); }, 2000);
    renderLeaderboard();
    updatePayloadCard();
  }

  window.addEventListener("DOMContentLoaded", boot);
  window.RaceController = controller;
  window.RaceTick = tick;
  window.RaceEvaluateAll = evaluateAll;
})();
