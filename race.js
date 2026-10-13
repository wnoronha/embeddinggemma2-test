// SystemOne fair race: one canonical road, N OpenRouter models in parallel.
// Keys in localStorage only.

(function () {
  "use strict";

  var LS = {
    orKey: "racer.key.openrouter",
    selectedModels: "racer.models.selected",
  };

  var DEFAULT_MODELS = [
    "typesafe/jev-1.13",
    "openai/gpt-6-luna-decisions",
    "microsoft/microsoft-decision-1",
  ];

  var LEGACY_MODEL_MAP = {
    "typesafe/jev-latest": "typesafe/jev-1.13",
    "~typesafe/jev-latest": "typesafe/jev-1.13",
    "typesafe/jev-router": null,
  };

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
    autoRace: true,
    lastWaveAt: 0,
    WAVE_MS: 7000,
    CRASH_RESET_MS: 3000,
    catalog: [],
    selectedModelIds: [],
    pendingModelIds: [],
    modalOpen: false,
    modalFilter: "",
    intervals: [],
  };

  function slug(id) {
    return String(id).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  }

  function getApiKey() {
    var el = $("key-openrouter");
    return el ? el.value.trim() : "";
  }

  function loadSelectedModels() {
    try {
      var raw = loadLS(LS.selectedModels, "");
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) return parsed;
      }
    } catch (e) { /* ignore */ }
    return DEFAULT_MODELS.slice();
  }

  function saveSelectedModels(ids) {
    saveLS(LS.selectedModels, JSON.stringify(ids));
  }

  function normalizeSelectedModels(ids, catalog) {
    var valid = new Set((catalog || []).map(function (m) { return m.id; }));
    var out = [];
    (ids || []).forEach(function (id) {
      if (id && id.charAt(0) === "~") return;
      if (LEGACY_MODEL_MAP.hasOwnProperty(id)) {
        var mapped = LEGACY_MODEL_MAP[id];
        if (mapped && valid.has(mapped) && out.indexOf(mapped) === -1) out.push(mapped);
        return;
      }
      if (valid.has(id) && out.indexOf(id) === -1) out.push(id);
    });
    if (!out.length) {
      DEFAULT_MODELS.forEach(function (d) {
        if (valid.has(d) && out.indexOf(d) === -1) out.push(d);
      });
    }
    return out;
  }

  function statsFor(id) {
    if (!controller.stats[id]) controller.stats[id] = { calls: 0, errors: 0, latencies: [], crashes: 0 };
    return controller.stats[id];
  }

  function avg(a) {
    if (!a.length) return 0;
    return Math.round(a.reduce(function (s, x) { return s + x; }, 0) / a.length);
  }

  function setHeaderStatus(text, kind) {
    var dot = $("serverStatusDot");
    var label = $("serverStatusText");
    if (label) label.textContent = text;
    if (dot) {
      dot.classList.remove("loading", "failed", "ready");
      if (kind) dot.classList.add(kind);
    }
  }

  function renderLeaderboard() {
    var el = $("leaderboard");
    if (!el) return;
    if (!controller.tracks.length) {
      el.innerHTML = '<div class="lb-empty">Select at least one model to start the race.</div>';
      return;
    }
    var rows = controller.tracks.map(function (t) {
      var s = statsFor(t.provider.id);
      return {
        label: t.provider.label,
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
        `<span class="lb-cell lb-pill ${r.state === "CRASHED" ? "bad" : ""}">${r.state}</span>` +
        `<span class="lb-cell">${r.calls} calls</span>` +
        `<span class="lb-cell">${r.errors} err</span>` +
        `<span class="lb-cell">avg ${r.avgMs}ms</span>` +
        `<span class="lb-cell">last ${r.lastMs}ms</span>` +
        `<span class="lb-cell">${r.crashes} crashes</span></div>`;
    }).join("");
  }

  function makeProvider(modelId, meta) {
    var RP = window.RaceProviders;
    var label = (meta && meta.label) || modelId;
    return {
      id: slug(modelId),
      modelId: modelId,
      label: label,
      surface: meta && meta.surface,
      needsKey: true,
      decide: function (laneState) {
        return RP.decideForOpenRouterModel(laneState, {
          apiKey: getApiKey(),
          model: modelId,
        });
      },
    };
  }

  function trackCardHtml(modelId, meta) {
    var sid = slug(modelId);
    var surface = "Decisions API";
    return (
      '<div class="track-card" data-model="' + modelId + '">' +
      '<div class="track-header">' +
      '<span class="track-name">' + (meta.label || modelId) + '</span>' +
      '<span class="track-sub">' + surface + '</span></div>' +
      '<div class="road-viewport small"><canvas id="canvas-' + sid + '" width="220" height="380"></canvas></div>' +
      '<div class="status-meta">' +
      '<div class="meta-col"><span class="meta-label">Current</span><span class="meta-value" id="' + sid + '-Current">Lane 2</span></div>' +
      '<div class="meta-col"><span class="meta-label">Choice</span><span class="meta-value highlight" id="' + sid + '-Decision">—</span></div>' +
      '<div class="meta-col"><span class="meta-label">Latency</span><span class="meta-value" id="' + sid + '-Latency">—</span></div>' +
      '</div>' +
      '<div class="status-meta engine-meta">' +
      '<div class="meta-col wide"><span class="meta-label">Model</span><span class="meta-value small mono" id="' + sid + '-Engine">' + modelId + '</span></div></div>' +
      '<div class="status-meta engine-meta">' +
      '<div class="meta-col wide"><span class="meta-label">Probabilities</span><span class="meta-value small mono" id="' + sid + '-Sims">—</span></div></div>' +
      '<div class="status-meta engine-meta">' +
      '<div class="meta-col wide"><span class="meta-label">Debug</span><span class="meta-value small mono" id="' + sid + '-Debug">waiting…</span></div></div>' +
      '</div>'
    );
  }

  function destroyTracks() {
    controller.tracks.forEach(function (t) {
      if (t.game && typeof t.game.destroy === "function") t.game.destroy();
    });
    controller.tracks = [];
    controller.intervals.forEach(clearInterval);
    controller.intervals = [];
  }

  function rebuildTracks() {
    var grid = $("raceGrid");
    if (!grid) return;
    destroyTracks();
    var RP = window.RaceProviders;
    var catalog = controller.catalog.length ? controller.catalog : (RP ? RP.DECISIONS_CATALOG_FALLBACK : []);
    var byId = {};
    catalog.forEach(function (m) { byId[m.id] = m; });

    var ids = controller.selectedModelIds.filter(function (id) { return !!id; });
    if (!ids.length) {
      grid.innerHTML = "";
      renderLeaderboard();
      setHeaderStatus("Pick models to race", "loading");
      return;
    }

    grid.innerHTML = ids.map(function (id) {
      return trackCardHtml(id, byId[id] || { id: id, label: id, surface: "systemone" });
    }).join("");

    var key = getApiKey();
    ids.forEach(function (modelId) {
      var sid = slug(modelId);
      var meta = byId[modelId] || { label: modelId };
      var p = makeProvider(modelId, meta);
      var game = new window.CarGame({
        canvasId: "canvas-" + sid,
        idPrefix: sid + "-",
        provider: p,
        onDecision: function (res, err) {
          var s = statsFor(p.id);
          if (err) s.errors++;
          else if (res) {
            s.calls++;
            if (res.latencyMs != null) {
              s.latencies.push(res.latencyMs);
              if (s.latencies.length > 20) s.latencies.shift();
            }
          }
          var tr = controller.tracks.find(function (x) { return x.provider.id === p.id; });
          if (tr && res && res.latencyMs != null) tr.lastMs = res.latencyMs;
          renderLeaderboard();
        },
      });
      game.decisionCooldown = 1500;
      var origCrash = game.triggerCrash.bind(game);
      game.triggerCrash = function (obs) {
        statsFor(p.id).crashes++;
        game.crashedAt = performance.now();
        origCrash(obs);
        var pb = $("pauseBtn");
        if (pb) pb.textContent = "Restart after crash";
        renderLeaderboard();
      };
      controller.tracks.push({ provider: p, game: game, lastMs: 0 });
    });

    if (key) setHeaderStatus(ids.length + " model" + (ids.length === 1 ? "" : "s") + " racing", "ready");
    else setHeaderStatus("Add OpenRouter API key", "loading");

    mirrorToAll();
    renderLeaderboard();
    startCadence();
  }

  function startCadence() {
    controller.intervals.push(setInterval(function () {
      if (controller.canonicalLanes.length) evaluateAll(false);
    }, 2500));
    controller.intervals.push(setInterval(tick, 1000));
    controller.intervals.push(setInterval(function () { updatePayloadCard(); }, 2000));
  }

  function activeBlockedLanes() {
    var t0 = controller.tracks[0];
    if (!t0) return controller.canonicalLanes.slice();
    var carY = t0.game.carY;
    var live = t0.game.obstacles
      .filter(function (o) { return o.y < carY + 30 && o.y > -50; })
      .map(function (o) { return o.lane; });
    return [...new Set(live)];
  }

  async function evaluateAll(force) {
    if (!controller.tracks.length) return;
    var RP = window.RaceProviders;
    var blocked = activeBlockedLanes();
    if (blocked.length === 0 || blocked.length === 3) {
      controller.tracks.forEach(function (t) { t.game.evaluateDecisions(true, null); });
      renderLeaderboard();
      return;
    }
    var shared = RP.buildLaneState(blocked, null);
    var withCurrent = controller.tracks.map(function (t) {
      var s = Object.assign({}, shared, {
        stateObj: Object.assign({}, shared.stateObj, { currentLane: t.game.currentLane }),
      });
      return { track: t, state: s };
    });
    await Promise.allSettled(withCurrent.map(function (w) {
      return w.track.game.evaluateDecisions(force !== false, w.state);
    }));
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
    var st = window.RaceProviders.buildLaneState(blocked, 2);
    var models = controller.tracks.map(function (t) { return t.provider.modelId; });
    el.textContent = JSON.stringify({
      endpoint: "POST https://openrouter.ai/api/alpha/decisions",
      models: models,
      body: {
        model: models[0] || "typesafe/jev-1.13",
        state: st.stateObj,
        questions: {
          lane_choice: {
            type: "choice",
            instructions: st.instructions,
            criteria: st.criteria,
          },
        },
      },
    }, null, 2);
  }

  function stampWave() { controller.lastWaveAt = performance.now(); }

  function waveCleared() {
    var t0 = controller.tracks[0];
    if (!t0) return true;
    if (!t0.game.obstacles.length) return true;
    return t0.game.obstacles.every(function (o) { return o.y > t0.game.carY + 80; });
  }

  function autoResetTrack(t) {
    var g = t.game;
    g.obstacles.forEach(function (o) {
      if (Math.abs(o.y - g.carY) < 80) o.y -= 160;
    });
    g.resetGame();
  }

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
      if (pb && pb.textContent === "Restart after crash") pb.textContent = "Pause race";
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
    controller.isRandom = true;
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

  function catalogById() {
    var byId = {};
    controller.catalog.forEach(function (m) { byId[m.id] = m; });
    return byId;
  }

  function renderSettingsSummary() {
    var countEl = $("selectedModelCount");
    var pillsEl = $("selectedModelPills");
    var openBtn = $("openModelsModalBtn");
    var n = controller.selectedModelIds.length;
    if (countEl) countEl.textContent = String(n);
    if (openBtn) openBtn.textContent = n ? n + " model" + (n === 1 ? "" : "s") + " racing" : "Choose models";
    if (!pillsEl) return;
    var byId = catalogById();
    if (!n) {
      pillsEl.innerHTML = '<span class="settings-empty">No models selected — open the picker to start.</span>';
      return;
    }
    pillsEl.innerHTML = controller.selectedModelIds.slice(0, 6).map(function (id) {
      var m = byId[id] || { label: id, isFree: false };
      return '<span class="summary-pill' + (m.isFree ? " free" : "") + '">' + m.label + '</span>';
    }).join("") + (n > 6 ? '<span class="summary-more">+' + (n - 6) + " more</span>" : "");
  }

  function filteredCatalog() {
    var q = (controller.modalFilter || "").trim().toLowerCase();
    if (!q) return controller.catalog.slice();
    return controller.catalog.filter(function (m) {
      return (m.id + " " + m.label + " " + m.vendor).toLowerCase().indexOf(q) !== -1;
    });
  }

  function renderModelModalList() {
    var listEl = $("modelModalList");
    if (!listEl) return;
    var selected = new Set(controller.pendingModelIds);
    var items = filteredCatalog();
    var freeCount = controller.catalog.filter(function (m) { return m.isFree; }).length;
    var countLabel = $("modalCatalogMeta");
    if (countLabel) {
      countLabel.textContent = controller.catalog.length + " pinned models · " + freeCount + " free";
    }
    if (!items.length) {
      listEl.innerHTML = '<div class="modal-empty">No models match your search.</div>';
      return;
    }
    var lastVendor = "";
    var html = "";
    items.forEach(function (m) {
      if (m.vendor !== lastVendor) {
        lastVendor = m.vendor;
        html += '<div class="modal-vendor">' + lastVendor + '</div>';
      }
      var on = selected.has(m.id);
      var freeCls = m.isFree ? " is-free" : "";
      html +=
        '<label class="modal-model-row' + freeCls + (on ? " selected" : "") + '">' +
        '<input type="checkbox" class="modal-check" data-id="' + m.id + '"' + (on ? " checked" : "") + " />" +
        '<span class="modal-model-main">' +
        '<span class="modal-model-name">' + m.label +
        (m.isFree ? '<span class="badge-free">Free</span>' : "") +
        "</span>" +
        '<span class="modal-model-id">' + m.id + "</span>" +
        "</span></label>";
    });
    listEl.innerHTML = html;
    listEl.querySelectorAll(".modal-check").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var id = cb.getAttribute("data-id");
        var set = new Set(controller.pendingModelIds);
        if (cb.checked) set.add(id);
        else set.delete(id);
        controller.pendingModelIds = Array.from(set);
        updateModalApplyLabel();
        var row = cb.closest(".modal-model-row");
        if (row) row.classList.toggle("selected", cb.checked);
      });
    });
    updateModalApplyLabel();
  }

  function updateModalApplyLabel() {
    var btn = $("modalApplyBtn");
    var n = controller.pendingModelIds.length;
    if (btn) btn.textContent = n ? "Apply (" + n + ")" : "Apply";
  }

  function openModelsModal() {
    controller.pendingModelIds = controller.selectedModelIds.slice();
    controller.modalFilter = "";
    var search = $("modelModalSearch");
    if (search) search.value = "";
    controller.modalOpen = true;
    var backdrop = $("modelsModal");
    if (backdrop) {
      backdrop.hidden = false;
      document.body.classList.add("modal-open");
    }
    renderModelModalList();
  }

  function closeModelsModal() {
    controller.modalOpen = false;
    var backdrop = $("modelsModal");
    if (backdrop) {
      backdrop.hidden = true;
      document.body.classList.remove("modal-open");
    }
  }

  function applyModelsFromModal() {
    controller.selectedModelIds = controller.pendingModelIds.slice();
    saveSelectedModels(controller.selectedModelIds);
    closeModelsModal();
    renderSettingsSummary();
    rebuildTracks();
    if (controller.tracks.length && controller.autoRace) spawnRandom(2);
  }

  function selectAllFreeInModal() {
    var set = new Set(controller.pendingModelIds);
    controller.catalog.forEach(function (m) {
      if (m.isFree) set.add(m.id);
    });
    controller.pendingModelIds = Array.from(set);
    renderModelModalList();
  }

  function clearModalSelection() {
    controller.pendingModelIds = [];
    renderModelModalList();
  }

  async function refreshCatalog() {
    var RP = window.RaceProviders;
    if (!RP) return;
    var btn = $("refreshModelsBtn");
    if (btn) btn.disabled = true;
    setHeaderStatus("Refreshing models…", "loading");
    try {
      controller.catalog = await RP.fetchOpenRouterDecisionModels(getApiKey());
    } catch (e) {
      controller.catalog = RP.DECISIONS_CATALOG_FALLBACK.slice();
    } finally {
      if (btn) btn.disabled = false;
    }
    controller.selectedModelIds = normalizeSelectedModels(controller.selectedModelIds, controller.catalog);
    saveSelectedModels(controller.selectedModelIds);
    renderSettingsSummary();
    if (controller.modalOpen) renderModelModalList();
    var key = getApiKey();
    if (key && controller.tracks.length) setHeaderStatus(controller.tracks.length + " models racing", "ready");
    else if (key) setHeaderStatus("Ready — select models", "ready");
    else setHeaderStatus("Add OpenRouter API key", "loading");
  }

  function boot() {
    if (!$("raceGrid")) return;

    $("key-openrouter").value = loadLS(LS.orKey, "");
    controller.selectedModelIds = loadSelectedModels();

    $("key-openrouter").addEventListener("input", function (e) {
      saveLS(LS.orKey, e.target.value);
      if (e.target.value.trim()) {
        setHeaderStatus(controller.tracks.length ? controller.tracks.length + " models racing" : "Ready — select models", "ready");
      } else {
        setHeaderStatus("Add OpenRouter API key", "loading");
      }
    });

    $("pauseBtn").addEventListener("click", function () {
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
        autoBtn.textContent = controller.autoRace ? "Auto waves: on" : "Auto waves: off";
        autoBtn.classList.toggle("active", controller.autoRace);
        if (controller.autoRace) stampWave();
      });
    }

    $("openModelsModalBtn").addEventListener("click", openModelsModal);
    $("openSettingsBtn").addEventListener("click", openModelsModal);
    $("modalCloseBtn").addEventListener("click", closeModelsModal);
    $("modalCancelBtn").addEventListener("click", closeModelsModal);
    $("modalApplyBtn").addEventListener("click", applyModelsFromModal);
    $("modalRefreshBtn").addEventListener("click", function () { refreshCatalog(); });
    $("modalSelectFreeBtn").addEventListener("click", selectAllFreeInModal);
    $("modalClearBtn").addEventListener("click", clearModalSelection);
    $("modelModalSearch").addEventListener("input", function (e) {
      controller.modalFilter = e.target.value;
      renderModelModalList();
    });
    $("modelsModal").addEventListener("click", function (e) {
      if (e.target === $("modelsModal")) closeModelsModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && controller.modalOpen) closeModelsModal();
    });

    window.raceSpawn = spawnLane;
    window.raceRandom = spawnRandom;
    window.raceClear = clearRoad;

    renderSettingsSummary();
    refreshCatalog().then(function () {
      renderSettingsSummary();
      rebuildTracks();
      if (controller.tracks.length && controller.autoRace) spawnRandom(2);
    });
  }

  window.addEventListener("DOMContentLoaded", boot);
  window.RaceController = controller;
  window.RaceTick = tick;
  window.RaceEvaluateAll = evaluateAll;
  window.RaceGetOpenRouterKey = getApiKey;
})();
