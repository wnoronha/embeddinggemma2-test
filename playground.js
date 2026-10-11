// Playground tab: arbitrary query/instructions/choices -> same DecisionEngine.
// No duplicate model code: calls window.DecisionEngine.evaluateChoiceText().
// If the model is not loaded, shows "Waiting for model…" — never fakes a result.

(function () {
  function $(id) { return document.getElementById(id); }

  function switchTab(which) {
    const driving = which === "driving";
    $("tabDriving").classList.toggle("active", driving);
    $("tabPlayground").classList.toggle("active", !driving);
    $("drivingView").hidden = !driving;
    $("playgroundView").hidden = driving;
  }

  function parseChoices(text) {
    return text.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const sep = line.indexOf("|");
        if (sep === -1) return { label: line, description: line };
        return {
          label: line.slice(0, sep).trim(),
          description: line.slice(sep + 1).trim(),
        };
      });
  }

  async function onSubmit() {
    const btn = $("pgSubmit");
    const status = $("pgStatus");
    const out = $("pgResponse");
    const query = $("pgQuery").value.trim();
    const instructions = $("pgInstructions").value.trim();
    const options = parseChoices($("pgChoices").value);

    if (!query) { status.textContent = "Enter a query."; return; }
    if (options.length === 0) { status.textContent = "Enter at least one choice."; return; }

    const DE = window.DecisionEngine;
    if (!(DE && DE.isModelReady())) {
      status.textContent = "Waiting for model…";
      out.textContent = "Model not loaded yet. Wait for the status indicator, then hit Submit again.";
      return;
    }

    btn.disabled = true;
    status.textContent = "Running…";
    try {
      const res = await DE.evaluateChoiceText(query, instructions, options);
      const shown = {
        selected: res.selected,
        similarities: res.similarities,
        latencyMs: res.latencyMs,
        engine: res.engine,
      };
      out.textContent = JSON.stringify(shown, null, 2);
      status.textContent = `Done in ${res.latencyMs} ms`;
    } catch (err) {
      console.warn("[playground] inference failed:", err);
      status.textContent = "Error — see console.";
      out.textContent = `Error: ${err?.message || err}`;
    } finally {
      btn.disabled = false;
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    $("tabDriving").addEventListener("click", () => switchTab("driving"));
    $("tabPlayground").addEventListener("click", () => switchTab("playground"));
    $("pgSubmit").addEventListener("click", onSubmit);
  });
})();
