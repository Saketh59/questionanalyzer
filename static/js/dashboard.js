// Dashboard logic: calls Flask APIs and renders charts
(function () {
  // Elements
  const qaText = document.getElementById('qa-text');
  const analyzeBtn = document.getElementById('analyzeBtn');
  const analyzeFileBtn = document.getElementById('analyzeFileBtn');
  const analyzeImageBtn = document.getElementById('analyzeImageBtn');
  const qaFile = document.getElementById('qa-file');
  const qaImage = document.getElementById('qa-image');
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
  // Multi-format elements
  const formatsResults = document.getElementById('formatsResults');
  const fmtMCQ = document.getElementById('fmt-mcqs');
  const fmtFIB = document.getElementById('fmt-fib');
  const fmtTF = document.getElementById('fmt-tf');
  const fmtSA = document.getElementById('fmt-sa');
  const fmtCS = document.getElementById('fmt-cs');
  const fmtMCQWrap = document.getElementById('fmt-mcqs-wrap');
  const fmtFIBWrap = document.getElementById('fmt-fib-wrap');
  const fmtTFWrap = document.getElementById('fmt-tf-wrap');
  const fmtSAWrap = document.getElementById('fmt-sa-wrap');
  const fmtCSWrap = document.getElementById('fmt-cs-wrap');
  const genFormat = document.getElementById('gen-format');
  const toggleAnswersBtn = document.getElementById('toggleAnswersBtn');
  const saveAnalyzeBtn = document.getElementById('saveAnalyzeBtn');
  const exportAnalyzeBtn = document.getElementById('exportAnalyzeBtn');
  const saveGenerateBtn = document.getElementById('saveGenerateBtn');
  const exportGenerateBtn = document.getElementById('exportGenerateBtn');

  // State for persistence
  let latestAnalyzeItems = [];
  let latestGenerateItems = [];
  let latestParagraph = '';

  // Charts
  let diffChart, diffDonutChart, bloomChart, genDiffChart, genBloomChart;

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
    const diffDonutCtx = document.getElementById('diffDonutChart');
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
    if (diffDonutCtx) {
      // Destroy previous if any
      if (diffDonutChart && typeof diffDonutChart.destroy === 'function') {
        try { diffDonutChart.destroy(); } catch (e) {}
      }
      const colors = ['#22c55e','#f59e0b','#ef4444'];
      // normalize to Easy, Medium, Hard ordering
      const donutData = [diffMap.Easy||0, diffMap.Medium||0, diffMap.Hard||0];
      diffDonutChart = new Chart(diffDonutCtx, {
        type: 'doughnut',
        data: { labels: ['Easy','Medium','Hard'], datasets: [{ data: donutData, backgroundColor: colors, borderWidth: 0 }] },
        options: { plugins: { legend: { labels: { color: '#cbd5e1' } } }, cutout: '55%' }
      });
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

  function renderAnalyzeList(items) {
    if (!analyzeList) return;
    analyzeList.innerHTML = '';
    // Helpers for concise, color-coded feedback
    function classifyFeedback(text) {
      const t = (text || '').toLowerCase();
      if (/(analy|compare|evaluate|justify|assess|critique)/.test(t)) return { label: 'Analytical', cls: 'bg-indigo-600/20 text-indigo-300 border border-indigo-400/20' };
      if (/(ambig|vague|pronoun|specific)/.test(t)) return { label: 'Clarity', cls: 'bg-amber-500/20 text-amber-300 border border-amber-400/20' };
      if (/(clarity|readab|simplif|concise)/.test(t)) return { label: 'Readable', cls: 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/20' };
      if (/(outcome|higher-order|bloom|align)/.test(t)) return { label: 'Outcomes', cls: 'bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-400/20' };
      return { label: 'Suggest', cls: 'bg-gray-500/20 text-gray-300 border border-gray-400/20' };
    }
    function concise(text, max = 120) {
      const t = String(text || '').trim();
      if (t.length <= max) return t;
      return t.slice(0, max - 1).trimEnd() + '…';
    }
    items.forEach((it) => {
      const li = document.createElement('li');
      const top = document.createElement('div');
      top.innerHTML = `<span class="font-medium">${it.text}</span> <span class="ml-2 text-xs text-white/60">[${it.difficulty} • ${it.bloom} • ${it.readability}]`;
      li.appendChild(top);
      const fb = it.feedback || [];
      if (fb.length) {
        const ul = document.createElement('ul');
        ul.className = 'mt-2 ml-5 space-y-1';
        fb.slice(0, 4).forEach(s => {
          const fli = document.createElement('li');
          const { label, cls } = classifyFeedback(s);
          fli.innerHTML = `<span class=\"inline-block px-2 py-0.5 mr-2 rounded-full text-[11px] ${cls}\">${label}</span><span class=\"text-white/80 text-sm\">${concise(s)}</span>`;
          ul.appendChild(fli);
        });

  // Separate handler for image OCR analysis (uses qa-image input)
  analyzeImageBtn?.addEventListener('click', async () => {
    const file = qaImage?.files?.[0];
    if (!file) { alert('Please choose an image file.'); return; }
    try {
      analyzeImageBtn.disabled = true;
      const fd = new FormData();
      fd.append('file', file);
      const resp = await fetch('/api/analyze_file', {
        method: 'POST',
        body: fd
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Analyze image failed: ${txt}`);
      }
      const data = await resp.json();

      const results = data.results || [];
      if (!results.length) {
        alert(data.note || 'No questions detected in the uploaded image.');
        return;
      }

      const first = results[0];
      resDifficulty.textContent = first.difficulty || '—';
      resBloom.textContent = first.bloom || '—';
      resClarity.textContent = `${first.readability ?? '—'}`;
      resClarityDesc.textContent = isFinite(first.readability) ? clarityDescription(Number(first.readability)) : '';

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

      latestAnalyzeItems = results.map(r => ({ text: r.text, difficulty: r.difficulty, bloom: r.bloom, readability: r.readability, feedback: r.feedback || [] }));
      renderAnalyzeList(latestAnalyzeItems);
      analyzeResults.classList.remove('hidden');
      analyzeResults.classList.add('animate-fade-in');
    } catch (e) {
      console.error('Analyze image error:', e);
      alert(`Failed to analyze image. ${e?.message || ''}`.trim());
    } finally {
      analyzeImageBtn.disabled = false;
    }
  });

  
        li.appendChild(ul);
      }
      analyzeList.appendChild(li);
    });
  }

  analyzeBtn?.addEventListener('click', async () => {
    // If user selected an image, analyze that via OCR first
    if (qaImage?.files?.[0]) {
      const file = qaImage.files[0];
      try {
        analyzeBtn.disabled = true;
        const fd = new FormData();
        fd.append('file', file);
        const resp = await fetch('/api/analyze_file', { method: 'POST', body: fd });
        if (!resp.ok) { const txt = await resp.text(); throw new Error(`Analyze image failed: ${txt}`); }
        const data = await resp.json();
        const results = data.results || [];
        if (!results.length) { alert(data.note || 'No questions detected in the uploaded image.'); return; }
        const first = results[0];
        resDifficulty.textContent = first.difficulty || '—';
        resBloom.textContent = first.bloom || '—';
        resClarity.textContent = `${first.readability ?? '—'}`;
        resClarityDesc.textContent = isFinite(first.readability) ? clarityDescription(Number(first.readability)) : '';
        const summary = data.summary || {};
        if (summary && (summary.difficulty || summary.bloom)) {
          setAnalyzeSummary(summary);
        } else {
          const diffCounts = {}; const bloomCounts = {};
          results.forEach(r => { diffCounts[r.difficulty] = (diffCounts[r.difficulty] || 0) + 1; bloomCounts[r.bloom] = (bloomCounts[r.bloom] || 0) + 1; });
          setAnalyzeSummary({ difficulty: diffCounts, bloom: bloomCounts });
        }
        latestAnalyzeItems = results.map(r => ({ text: r.text, difficulty: r.difficulty, bloom: r.bloom, readability: r.readability, feedback: r.feedback || [] }));
        renderAnalyzeList(latestAnalyzeItems);
        analyzeResults.classList.remove('hidden');
        analyzeResults.classList.add('animate-fade-in');
      } catch (e) {
        console.error('Analyze image (via Analyze button) error:', e);
        alert(`Failed to analyze image. ${e?.message || ''}`.trim());
      } finally {
        analyzeBtn.disabled = false;
      }
      return;
    }

    // If user selected a general file (PDF/image), analyze that
    if (qaFile?.files?.[0]) {
      const file = qaFile.files[0];
      try {
        analyzeBtn.disabled = true;
        const fd = new FormData();
        fd.append('file', file);
        const resp = await fetch('/api/analyze_file', { method: 'POST', body: fd });
        if (!resp.ok) { const txt = await resp.text(); throw new Error(`Analyze file failed: ${txt}`); }
        const data = await resp.json();
        const results = data.results || [];
        if (!results.length) { alert(data.note || 'No questions detected in the uploaded file.'); return; }
        const first = results[0];
        resDifficulty.textContent = first.difficulty || '—';
        resBloom.textContent = first.bloom || '—';
        resClarity.textContent = `${first.readability ?? '—'}`;
        resClarityDesc.textContent = isFinite(first.readability) ? clarityDescription(Number(first.readability)) : '';
        const summary = data.summary || {};
        if (summary && (summary.difficulty || summary.bloom)) {
          setAnalyzeSummary(summary);
        } else {
          const diffCounts = {}; const bloomCounts = {};
          results.forEach(r => { diffCounts[r.difficulty] = (diffCounts[r.difficulty] || 0) + 1; bloomCounts[r.bloom] = (bloomCounts[r.bloom] || 0) + 1; });
          setAnalyzeSummary({ difficulty: diffCounts, bloom: bloomCounts });
        }
        latestAnalyzeItems = results.map(r => ({ text: r.text, difficulty: r.difficulty, bloom: r.bloom, readability: r.readability, feedback: r.feedback || [] }));
        renderAnalyzeList(latestAnalyzeItems);
        analyzeResults.classList.remove('hidden');
        analyzeResults.classList.add('animate-fade-in');
      } catch (e) {
        console.error('Analyze file (via Analyze button) error:', e);
        alert(`Failed to analyze file. ${e?.message || ''}`.trim());
      } finally {
        analyzeBtn.disabled = false;
      }
      return;
    }

    // Otherwise, fall back to text analysis
    const raw = (qaText?.value || '').trim();
    if (!raw) {
      alert('Please paste a question, or choose a file/image to analyze.');
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
        latestAnalyzeItems = [{ text: payload.question, difficulty: data.difficulty, bloom: data.bloom, readability: data.readability, feedback: data.feedback || [] }];
        renderAnalyzeList(latestAnalyzeItems);
      } else {
        // Multiple
        const first = data.results?.[0] || { difficulty: '—', bloom: '—', readability: '—' };
        resDifficulty.textContent = first.difficulty;
        resBloom.textContent = first.bloom;
        resClarity.textContent = `${first.readability}`;
        resClarityDesc.textContent = isFinite(first.readability) ? clarityDescription(Number(first.readability)) : '';
        setAnalyzeSummary(data.summary || {});
        latestAnalyzeItems = (data.results || []).map(r => ({ text: r.text, difficulty: r.difficulty, bloom: r.bloom, readability: r.readability, feedback: r.feedback || [] }));
        renderAnalyzeList(latestAnalyzeItems);
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

      latestAnalyzeItems = results.map(r => ({ text: r.text, difficulty: r.difficulty, bloom: r.bloom, readability: r.readability, feedback: r.feedback || [] }));
      renderAnalyzeList(latestAnalyzeItems);
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
    if (!paragraph) {
      alert('Please paste a paragraph.');
      return;
    }
    try {
      generateBtn.disabled = true;
      // Determine selected formats from single-select only
      let selectedFormats = [];
      const single = (genFormat?.value || 'All');
      if (single && single !== 'All') {
        selectedFormats = [single];
      } else {
        // Default to all formats
        selectedFormats = ['MCQs','FillInTheBlanks','TrueFalse','ShortAnswer','CaseStudy'];
      }
      const respFmt = await fetch('/api/generate_formats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paragraph, count, formats: selectedFormats })
      });
      if (!respFmt.ok) {
        const txt = await respFmt.text();
        throw new Error(`Generate formats failed: ${txt}`);
      }
      const dataFmt = await respFmt.json();

      // Hide and clear the standard list/charts since user wants only selected formats
      genList.innerHTML = '';
      if (genDiffChart) { genDiffChart.destroy(); genDiffChart = null; }
      if (genBloomChart) { genBloomChart.destroy(); genBloomChart = null; }
      genResults.classList.add('hidden');
      latestGenerateItems = [];
      latestParagraph = paragraph;

      const hasMCQ = Array.isArray(dataFmt.MCQs);
      const hasFIB = Array.isArray(dataFmt.FillInTheBlanks);
      const hasTF = Array.isArray(dataFmt.TrueFalse);
      const hasSA = Array.isArray(dataFmt.ShortAnswer);
      const hasCS = Array.isArray(dataFmt.CaseStudy);

      if (fmtMCQWrap) fmtMCQWrap.style.display = hasMCQ ? '' : 'none';
      if (fmtFIBWrap) fmtFIBWrap.style.display = hasFIB ? '' : 'none';
      if (fmtTFWrap) fmtTFWrap.style.display = hasTF ? '' : 'none';
      if (fmtSAWrap) fmtSAWrap.style.display = hasSA ? '' : 'none';
      if (fmtCSWrap) fmtCSWrap.style.display = hasCS ? '' : 'none';

      if (hasMCQ) renderMCQs(dataFmt.MCQs || [], false); else if (fmtMCQ) fmtMCQ.innerHTML = '';
      if (hasFIB) renderFIB(dataFmt.FillInTheBlanks || [], false); else if (fmtFIB) fmtFIB.innerHTML = '';
      if (hasTF) renderTF(dataFmt.TrueFalse || [], false); else if (fmtTF) fmtTF.innerHTML = '';
      if (hasSA) renderSA(dataFmt.ShortAnswer || [], false); else if (fmtSA) fmtSA.innerHTML = '';
      if (hasCS) renderCS(dataFmt.CaseStudy || [], false); else if (fmtCS) fmtCS.innerHTML = '';
      formatsResults?.classList.remove('hidden');
      formatsResults?.classList.add('animate-fade-in');
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
    // Also clear formats
    if (fmtMCQ) fmtMCQ.innerHTML = '';
    if (fmtFIB) fmtFIB.innerHTML = '';
    if (fmtTF) fmtTF.innerHTML = '';
    if (fmtSA) fmtSA.innerHTML = '';
    if (fmtCS) fmtCS.innerHTML = '';
    formatsResults?.classList.add('hidden');
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

  // ---------------- Multi-format rendering helpers ----------------
  function renderMCQs(items, showAnswers) {
    if (!fmtMCQ) return;
    fmtMCQ.innerHTML = '';
    items.forEach((it, idx) => {
      const wrap = document.createElement('div');
      wrap.className = 'p-4 rounded-lg bg-gray-800/60 border border-white/10';
      const q = document.createElement('div');
      q.className = 'font-medium mb-2';
      q.textContent = `${idx + 1}. ${it.question}`;
      wrap.appendChild(q);
      const opts = document.createElement('div');
      opts.className = 'space-y-1';
      (it.options || []).forEach((opt, oi) => {
        const id = `mcq-${idx}-${oi}`;
        const row = document.createElement('label');
        row.className = 'flex items-center gap-2 text-sm';
        row.innerHTML = `<input type="radio" name="mcq-${idx}" id="${id}" class="accent-indigo-500"/> <span>${opt}</span>`;
        opts.appendChild(row);
      });
      wrap.appendChild(opts);
      const ans = document.createElement('div');
      ans.className = 'mt-2 text-xs text-white/60';
      ans.textContent = `Answer: ${it.answer}`;
      if (!showAnswers) ans.style.display = 'none';
      ans.dataset.answer = 'true';
      wrap.appendChild(ans);
      fmtMCQ.appendChild(wrap);
    });
  }

  function renderFIB(items, showAnswers) {
    if (!fmtFIB) return;
    fmtFIB.innerHTML = '';
    items.forEach((it, idx) => {
      const wrap = document.createElement('div');
      wrap.className = 'p-4 rounded-lg bg-gray-800/60 border border-white/10';
      wrap.innerHTML = `<div class="font-medium mb-2">${idx + 1}. ${it.text}</div>`;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'w-full px-3 py-2 rounded bg-gray-900 border border-white/10';
      wrap.appendChild(input);
      const ans = document.createElement('div');
      ans.className = 'mt-2 text-xs text-white/60';
      ans.textContent = `Answer: ${it.answer}`;
      if (!showAnswers) ans.style.display = 'none';
      ans.dataset.answer = 'true';
      wrap.appendChild(ans);
      fmtFIB.appendChild(wrap);
    });
  }

  function renderTF(items, showAnswers) {
    if (!fmtTF) return;
    fmtTF.innerHTML = '';
    items.forEach((it, idx) => {
      const wrap = document.createElement('div');
      wrap.className = 'p-4 rounded-lg bg-gray-800/60 border border-white/10';
      wrap.innerHTML = `<div class="font-medium mb-2">${idx + 1}. ${it.statement}</div>`;
      const opts = document.createElement('div');
      opts.className = 'flex gap-4 text-sm';
      opts.innerHTML = `<label class="flex items-center gap-2"><input type="radio" name="tf-${idx}" class="accent-indigo-500" />True</label>
                        <label class="flex items-center gap-2"><input type="radio" name="tf-${idx}" class="accent-indigo-500" />False</label>`;
      wrap.appendChild(opts);
      const ans = document.createElement('div');
      ans.className = 'mt-2 text-xs text-white/60';
      ans.textContent = `Answer: ${it.answer ? 'True' : 'False'}`;
      if (!showAnswers) ans.style.display = 'none';
      ans.dataset.answer = 'true';
      wrap.appendChild(ans);
      fmtTF.appendChild(wrap);
    });
  }

  function renderSA(items, showAnswers) {
    if (!fmtSA) return;
    fmtSA.innerHTML = '';
    items.forEach((it, idx) => {
      const wrap = document.createElement('div');
      wrap.className = 'p-4 rounded-lg bg-gray-800/60 border border-white/10';
      wrap.innerHTML = `<div class="font-medium mb-2">${idx + 1}. ${it.question}</div>`;
      const ta = document.createElement('textarea');
      ta.rows = 2;
      ta.className = 'w-full px-3 py-2 rounded bg-gray-900 border border-white/10';
      wrap.appendChild(ta);
      const ans = document.createElement('div');
      ans.className = 'mt-2 text-xs text-white/60';
      ans.textContent = `Hint: ${it.answer_hint || ''}`;
      if (!showAnswers) ans.style.display = 'none';
      ans.dataset.answer = 'true';
      wrap.appendChild(ans);
      fmtSA.appendChild(wrap);
    });
  }

  function renderCS(items, showAnswers) {
    if (!fmtCS) return;
    fmtCS.innerHTML = '';
    items.forEach((it, idx) => {
      const wrap = document.createElement('div');
      wrap.className = 'p-4 rounded-lg bg-gray-800/60 border border-white/10';
      const head = document.createElement('div');
      head.className = 'font-semibold';
      head.textContent = `Case ${idx + 1}`;
      const caseP = document.createElement('div');
      caseP.className = 'mt-1 text-white/80';
      caseP.textContent = it.case;
      wrap.appendChild(head);
      wrap.appendChild(caseP);
      const list = document.createElement('ol');
      list.className = 'mt-2 list-decimal list-inside space-y-1';
      (it.questions || []).forEach(q => {
        const li = document.createElement('li');
        li.textContent = q;
        list.appendChild(li);
      });
      wrap.appendChild(list);
      fmtCS.appendChild(wrap);
    });
  }

  let showAnswers = false;
  toggleAnswersBtn?.addEventListener('click', () => {
    showAnswers = !showAnswers;
    // Toggle all nodes marked with data-answer
    formatsResults?.querySelectorAll('[data-answer]')?.forEach(el => {
      el.style.display = showAnswers ? '' : 'none';
    });
  });

})();
