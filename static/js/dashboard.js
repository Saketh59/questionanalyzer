// Dashboard logic: calls Flask APIs and renders charts
(function () {
  // Elements
  const qaText = document.getElementById('qa-text');
  const analyzeBtn = document.getElementById('analyzeBtn');
  const analyzeFileBtn = document.getElementById('analyzeFileBtn');
  const qaFile = document.getElementById('qa-file');
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
  const analyzeList = document.getElementById('analyze-list');
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

  function upsertChart(ctx, type, labels, data, currentInstanceGetter, currentInstanceSetter) {
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
    // Destroy previous if present BEFORE creating a new instance
    const old = currentInstanceGetter && currentInstanceGetter();
    if (old && typeof old.destroy === 'function') {
      try { old.destroy(); } catch (e) { /* noop */ }
    }
    const newChart = new Chart(ctx, { type, data: { labels, datasets: ds }, options });
    if (currentInstanceSetter) currentInstanceSetter(newChart);
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
        () => diffChart,
        (ni) => { diffChart = ni; }
      );
    }
    if (bloomCtx) {
      bloomChart = upsertChart(
        bloomCtx,
        'bar',
        bloomLabels,
        bloomData,
        () => bloomChart,
        (ni) => { bloomChart = ni; }
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
        () => genDiffChart,
        (ni) => { genDiffChart = ni; }
      );
    }
    if (bloomCtx) {
      genBloomChart = upsertChart(
        bloomCtx,
        'bar',
        bloomLabels,
        bloomData,
        () => genBloomChart,
        (ni) => { genBloomChart = ni; }
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
      analyzeBtn.disabled = true;
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
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Analyze failed: ${txt}`);
      }
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
        if (analyzeList) {
          analyzeList.innerHTML = '';
          const li = document.createElement('li');
          li.innerHTML = `<span class="font-medium">${payload.question}</span> <span class="ml-2 text-xs text-white/60">[${data.difficulty} • ${data.bloom} • ${data.readability}]`;
          analyzeList.appendChild(li);
        }
      } else {
        // Multiple
        const first = data.results?.[0] || { difficulty: '—', bloom: '—', readability: '—' };
        resDifficulty.textContent = first.difficulty;
        resBloom.textContent = first.bloom;
        resClarity.textContent = `${first.readability}`;
        resClarityDesc.textContent = isFinite(first.readability) ? clarityDescription(Number(first.readability)) : '';
        setAnalyzeSummary(data.summary || {});
        latestAnalyzeItems = (data.results || []).map(r => ({ text: r.text, difficulty: r.difficulty, bloom: r.bloom, readability: r.readability }));
        if (analyzeList) {
          analyzeList.innerHTML = '';
          (data.results || []).forEach(r => {
            const li = document.createElement('li');
            li.innerHTML = `<span class="font-medium">${r.text}</span> <span class="ml-2 text-xs text-white/60">[${r.difficulty} • ${r.bloom} • ${r.readability}]`;
            analyzeList.appendChild(li);
          });
        }
      }

      analyzeResults.classList.remove('hidden');
      analyzeResults.classList.add('animate-fade-in');
    } catch (e) {
      console.error('Analyze error:', e);
      alert(`Failed to analyze. ${e?.message || ''}`.trim());
    } finally {
      analyzeBtn.disabled = false;
    }
  });

  analyzeFileBtn?.addEventListener('click', async () => {
    const file = qaFile?.files?.[0];
    if (!file) { alert('Please choose a PDF or image file.'); return; }
    try {
      analyzeFileBtn.disabled = true;
      const fd = new FormData();
      fd.append('file', file);
      const resp = await fetch('/api/analyze_file', {
        method: 'POST',
        body: fd
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Analyze file failed: ${txt}`);
      }
      const data = await resp.json();

      const results = data.results || [];
      if (!results.length) {
        alert(data.note || 'No questions detected in the uploaded file.');
        return;
      }

      // Show first item like single analysis
      const first = results[0];
      resDifficulty.textContent = first.difficulty || '—';
      resBloom.textContent = first.bloom || '—';
      resClarity.textContent = `${first.readability ?? '—'}`;
      resClarityDesc.textContent = isFinite(first.readability) ? clarityDescription(Number(first.readability)) : '';

      // Charts from summary if present; else compute quickly
      const summary = data.summary || {};
      if (summary && (summary.difficulty || summary.bloom)) {
        setAnalyzeSummary(summary);
      } else {
        const diffCounts = {};
        const bloomCounts = {};
        results.forEach(r => {
          diffCounts[r.difficulty] = (diffCounts[r.difficulty] || 0) + 1;
          bloomCounts[r.bloom] = (bloomCounts[r.bloom] || 0) + 1;
        });
        setAnalyzeSummary({ difficulty: diffCounts, bloom: bloomCounts });
      }

      latestAnalyzeItems = results.map(r => ({ text: r.text, difficulty: r.difficulty, bloom: r.bloom, readability: r.readability }));
      if (analyzeList) {
        analyzeList.innerHTML = '';
        results.forEach(r => {
          const li = document.createElement('li');
          li.innerHTML = `<span class="font-medium">${r.text}</span> <span class="ml-2 text-xs text-white/60">[${r.difficulty} • ${r.bloom} • ${r.readability}]`;
          analyzeList.appendChild(li);
        });
      }
      analyzeResults.classList.remove('hidden');
      analyzeResults.classList.add('animate-fade-in');
    } catch (e) {
      console.error('Analyze file error:', e);
      alert(`Failed to analyze file. ${e?.message || ''}`.trim());
    } finally {
      analyzeFileBtn.disabled = false;
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
      generateBtn.disabled = true;
      const resp = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paragraph, count, difficulty, bloom })
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Generate failed: ${txt}`);
      }
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
      console.error('Generate error:', e);
      alert(`Failed to generate. ${e?.message || ''}`.trim());
    } finally {
      generateBtn.disabled = false;
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
