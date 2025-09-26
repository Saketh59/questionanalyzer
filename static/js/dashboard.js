// Dashboard logic: calls Flask APIs and renders charts
(function () {
  // Elements
  const qaText = document.getElementById('qa-text');
  const analyzeBtn = document.getElementById('analyzeBtn');
  const analyzeResults = document.getElementById('analyzeResults');
  const resDifficulty = document.getElementById('res-difficulty');
  const resBloom = document.getElementById('res-bloom');
  const resClarity = document.getElementById('res-clarity');
  const resClarityDesc = document.getElementById('res-clarity-desc');

  const genParagraph = document.getElementById('gen-paragraph');
  const genCount = document.getElementById('gen-count');
  const genDifficulty = document.getElementById('gen-difficulty');
  const genBloom = document.getElementById('gen-bloom');
  const generateBtn = document.getElementById('generateBtn');
  const clearGenBtn = document.getElementById('clearGenBtn');
  const genResults = document.getElementById('genResults');
  const genList = document.getElementById('gen-list');
  const saveAnalyzeBtn = document.getElementById('saveAnalyzeBtn');
  const exportAnalyzeBtn = document.getElementById('exportAnalyzeBtn');
  const saveGenerateBtn = document.getElementById('saveGenerateBtn');
  const exportGenerateBtn = document.getElementById('exportGenerateBtn');

  // State for persistence
  let latestAnalyzeItems = [];
  let latestGenerateItems = [];
  let latestParagraph = '';

  // Charts
  let diffChart, bloomChart, genDiffChart, genBloomChart;

  function upsertChart(ctx, type, labels, data, instanceRefSetter) {
    const colors = {
      Easy: '#22c55e',
      Medium: '#f59e0b',
      Hard: '#ef4444',
      Recall: '#60a5fa',
      Apply: '#a78bfa',
      Analyze: '#06b6d4'
    };
    const bg = labels.map(l => colors[l] || '#8b5cf6');
    const border = bg.map(c => c);

    const ds = [{ label: 'Count', data, backgroundColor: bg, borderColor: border, borderWidth: 1 }];
    const options = {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: type === 'bar' ? { y: { beginAtZero: true, ticks: { precision: 0 } } } : {}
    };
    const newChart = new Chart(ctx, { type, data: { labels, datasets: ds }, options });
    // Destroy previous if present on same canvas id
    const old = instanceRefSetter(newChart);
    if (old && typeof old.destroy === 'function') old.destroy();
    return newChart;
  }

  function setAnalyzeSummary(summary) {
    // Build charts using summary maps
    const diffMap = summary?.difficulty || {};
    const bloomMap = summary?.bloom || {};
    const diffLabels = Object.keys(diffMap);
    const diffData = diffLabels.map(k => diffMap[k]);
    const bloomLabels = Object.keys(bloomMap);
    const bloomData = bloomLabels.map(k => bloomMap[k]);

    const diffCtx = document.getElementById('diffChart');
    const bloomCtx = document.getElementById('bloomChart');
    if (diffCtx) {
      diffChart = upsertChart(
        diffCtx,
        'bar',
        diffLabels,
        diffData,
        (newInstance) => { const old = diffChart; diffChart = newInstance; return old; }
      );
    }
    if (bloomCtx) {
      bloomChart = upsertChart(
        bloomCtx,
        'bar',
        bloomLabels,
        bloomData,
        (newInstance) => { const old = bloomChart; bloomChart = newInstance; return old; }
      );
    }
  }

  function setGenSummary(summary) {
    const diffMap = summary?.difficulty || {};
    const bloomMap = summary?.bloom || {};
    const diffLabels = Object.keys(diffMap);
    const diffData = diffLabels.map(k => diffMap[k]);
    const bloomLabels = Object.keys(bloomMap);
    const bloomData = bloomLabels.map(k => bloomMap[k]);

    const diffCtx = document.getElementById('genDiffChart');
    const bloomCtx = document.getElementById('genBloomChart');
    if (diffCtx) {
      genDiffChart = upsertChart(
        diffCtx,
        'bar',
        diffLabels,
        diffData,
        (newInstance) => { const old = genDiffChart; genDiffChart = newInstance; return old; }
      );
    }
    if (bloomCtx) {
      genBloomChart = upsertChart(
        bloomCtx,
        'bar',
        bloomLabels,
        bloomData,
        (newInstance) => { const old = genBloomChart; genBloomChart = newInstance; return old; }
      );
    }
  }

  function clarityDescription(score) {
    if (score >= 80) return 'Very clear and concise.';
    if (score >= 60) return 'Generally clear; minor complexity.';
    if (score >= 40) return 'Moderately complex; could be simplified.';
    return 'Hard to read; consider breaking into simpler parts.';
  }

  analyzeBtn?.addEventListener('click', async () => {
    const raw = (qaText?.value || '').trim();
    if (!raw) {
      alert('Please paste a question (or multiple questions on new lines).');
      return;
    }
    const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    try {
      let payload, endpoint = '/api/analyze';
      if (lines.length > 1) {
        payload = { questions: lines };
      } else {
        payload = { question: lines[0] };
      }
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) throw new Error('Analyze request failed');
      const data = await resp.json();

      if (payload.question) {
        // Single
        resDifficulty.textContent = data.difficulty;
        resBloom.textContent = data.bloom;
        resClarity.textContent = `${data.readability}`;
        resClarityDesc.textContent = clarityDescription(Number(data.readability));
        setAnalyzeSummary({
          difficulty: { [data.difficulty]: 1 },
          bloom: { [data.bloom]: 1 }
        });
        latestAnalyzeItems = [{ text: payload.question, difficulty: data.difficulty, bloom: data.bloom, readability: data.readability }];
      } else {
        // Multiple
        const first = data.results?.[0] || { difficulty: '—', bloom: '—', readability: '—' };
        resDifficulty.textContent = first.difficulty;
        resBloom.textContent = first.bloom;
        resClarity.textContent = `${first.readability}`;
        resClarityDesc.textContent = isFinite(first.readability) ? clarityDescription(Number(first.readability)) : '';
        setAnalyzeSummary(data.summary || {});
        latestAnalyzeItems = (data.results || []).map(r => ({ text: r.text, difficulty: r.difficulty, bloom: r.bloom, readability: r.readability }));
      }

      analyzeResults.classList.remove('hidden');
      analyzeResults.classList.add('animate-fade-in');
    } catch (e) {
      console.error(e);
      alert('Failed to analyze. See console for details.');
    }
  });

  generateBtn?.addEventListener('click', async () => {
    const paragraph = (genParagraph?.value || '').trim();
    const count = Math.max(1, Math.min(20, parseInt(genCount?.value || '5', 10)));
    const difficulty = (genDifficulty?.value || 'any');
    const bloom = (genBloom?.value || 'any');
    if (!paragraph) {
      alert('Please paste a paragraph.');
      return;
    }
    try {
      const resp = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paragraph, count, difficulty, bloom })
      });
      if (!resp.ok) throw new Error('Generate request failed');
      const data = await resp.json();

      genList.innerHTML = '';
      (data.questions || []).forEach((q, idx) => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="font-medium">${q.text}</span> <span class="ml-2 text-xs text-white/60">[${q.difficulty} • ${q.bloom}]`;
        genList.appendChild(li);
      });

      setGenSummary(data.summary || {});
      genResults.classList.remove('hidden');
      genResults.classList.add('animate-fade-in');
      latestGenerateItems = (data.questions || []).map(q => ({ text: q.text, difficulty: q.difficulty, bloom: q.bloom }));
      latestParagraph = paragraph;
    } catch (e) {
      console.error(e);
      alert('Failed to generate. See console for details.');
    }
  });

  clearGenBtn?.addEventListener('click', () => {
    genList.innerHTML = '';
    genResults.classList.add('hidden');
    if (genDiffChart) { genDiffChart.destroy(); genDiffChart = null; }
    if (genBloomChart) { genBloomChart.destroy(); genBloomChart = null; }
  });

  // Save/Export bindings
  saveAnalyzeBtn?.addEventListener('click', async () => {
    if (!latestAnalyzeItems.length) { alert('No analyzed results to save.'); return; }
    try {
      const resp = await fetch('/api/save_analyzed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: latestAnalyzeItems })
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(JSON.stringify(json));
      alert(`Saved ${json.saved} analyzed item(s).`);
    } catch (e) { console.error(e); alert('Failed to save analyzed items.'); }
  });

  exportAnalyzeBtn?.addEventListener('click', () => {
    window.location.href = '/api/export?type=analyzed';
  });

  saveGenerateBtn?.addEventListener('click', async () => {
    if (!latestGenerateItems.length) { alert('No generated results to save.'); return; }
    try {
      const resp = await fetch('/api/save_generated', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paragraph: latestParagraph, items: latestGenerateItems })
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(JSON.stringify(json));
      alert(`Saved ${json.saved} generated item(s).`);
    } catch (e) { console.error(e); alert('Failed to save generated items.'); }
  });

  exportGenerateBtn?.addEventListener('click', () => {
    window.location.href = '/api/export?type=generated';
  });
})();
