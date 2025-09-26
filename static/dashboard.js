// Frontend-only logic for Analyze and Generate sections (mocked heuristics)
(function () {
  // Elements
  const qaText = document.getElementById('qa-text');
  const analyzeBtn = document.getElementById('analyzeBtn');
  const analyzeResults = document.getElementById('analyzeResults');
  const resDifficulty = document.getElementById('res-difficulty');
  const resBloom = document.getElementById('res-bloom');
  const resClarity = document.getElementById('res-clarity');
  const resClarityDesc = document.getElementById('res-clarity-desc');

  const genTopic = document.getElementById('gen-topic');
  const genCount = document.getElementById('gen-count');
  const genDifficulty = document.getElementById('gen-difficulty');
  const genBloom = document.getElementById('gen-bloom');
  const generateBtn = document.getElementById('generateBtn');
  const clearGenBtn = document.getElementById('clearGenBtn');
  const genResults = document.getElementById('genResults');
  const genList = document.getElementById('gen-list');

  // Heuristics for analysis
  const bloomKeywords = {
    Recall: [
      'define', 'list', 'name', 'recall', 'identify', 'state', 'what is', 'who is', 'when did'
    ],
    Apply: [
      'apply', 'use', 'calculate', 'demonstrate', 'solve', 'show how', 'compute', 'implement'
    ],
    Analyze: [
      'analyze', 'compare', 'contrast', 'differentiate', 'derive', 'prove', 'evaluate', 'assess', 'justify'
    ],
  };

  function classifyBloom(text) {
    const low = text.toLowerCase();
    for (const [level, words] of Object.entries(bloomKeywords)) {
      if (words.some((w) => low.includes(w))) return level;
    }
    // fallback: based on question mark and length
    if (low.includes('why') || low.includes('how')) return 'Analyze';
    if (low.length > 120) return 'Apply';
    return 'Recall';
  }

  function predictDifficulty(text) {
    const t = text.toLowerCase();
    let score = 0;
    // length-based
    if (text.length > 160) score += 2; else if (text.length > 90) score += 1;
    // vocabulary-based
    if (/prove|derive|theorem|optimize|analyze|complexity|integral|differential|regression/.test(t)) score += 2;
    if (/calculate|apply|design|implement|constraint|approximate|justify/.test(t)) score += 1;
    if (/list|define|name|identify|choose|select/.test(t)) score -= 1;

    if (score >= 3) return 'Hard';
    if (score >= 1) return 'Medium';
    return 'Easy';
  }

  // Very rough readability estimate (0-100). Higher = clearer
  function readabilityScore(text) {
    const sentences = text.split(/[.!?]+/).filter(Boolean).length || 1;
    const words = text.trim().split(/\s+/).filter(Boolean);
    const wordCount = words.length || 1;
    const chars = text.replace(/\s/g, '').length || 1;

    const avgWordsPerSentence = wordCount / sentences; // lower is clearer
    const avgCharsPerWord = chars / wordCount; // lower is clearer

    // Map to 0..100
    let score = 100;
    score -= Math.max(0, (avgWordsPerSentence - 14) * 2.5); // penalize long sentences
    score -= Math.max(0, (avgCharsPerWord - 5) * 10); // penalize long words
    score = Math.max(0, Math.min(100, Math.round(score)));
    return score;
  }

  function clarityDescription(score) {
    if (score >= 80) return 'Very clear and concise.';
    if (score >= 60) return 'Generally clear; minor complexity.';
    if (score >= 40) return 'Moderately complex; could be simplified.';
    return 'Hard to read; consider breaking into simpler parts.';
  }

  analyzeBtn?.addEventListener('click', () => {
    const text = (qaText?.value || '').trim();
    if (!text) {
      alert('Please paste a question to analyze.');
      return;
    }
    const diff = predictDifficulty(text);
    const bloom = classifyBloom(text);
    const clarity = readabilityScore(text);

    resDifficulty.textContent = diff;
    resBloom.textContent = bloom;
    resClarity.textContent = `${clarity}`;
    resClarityDesc.textContent = clarityDescription(clarity);

    analyzeResults.classList.remove('hidden');
    analyzeResults.classList.add('animate-fade-in');
  });

  // Generation
  const bloomPools = {
    Recall: [
      'Define', 'List', 'Identify', 'State', 'Name', 'Describe'
    ],
    Apply: [
      'Apply', 'Use', 'Calculate', 'Demonstrate', 'Solve', 'Compute'
    ],
    Analyze: [
      'Analyze', 'Compare', 'Contrast', 'Evaluate', 'Justify', 'Assess', 'Derive'
    ],
  };

  function makeQuestion(topic, bloom, difficulty) {
    const verbPool = bloomPools[bloom] || [].concat(...Object.values(bloomPools));
    const verb = verbPool[Math.floor(Math.random() * verbPool.length)] || 'Describe';
    const diffTag = difficulty !== 'any' ? ` [${difficulty}]` : '';
    return `${verb} a concept related to ${topic}.${diffTag}`;
  }

  generateBtn?.addEventListener('click', () => {
    const topic = (genTopic?.value || '').trim() || 'the topic';
    const count = Math.max(1, Math.min(20, parseInt(genCount?.value || '5', 10)));
    const diff = (genDifficulty?.value || 'any');
    const bloom = (genBloom?.value || 'any');

    genList.innerHTML = '';

    const blooms = bloom === 'any' ? ['Recall', 'Apply', 'Analyze'] : [bloom];

    for (let i = 0; i < count; i++) {
      const b = blooms[i % blooms.length];
      const q = makeQuestion(topic, b, diff);
      const li = document.createElement('li');
      li.textContent = q;
      genList.appendChild(li);
    }

    genResults.classList.remove('hidden');
    genResults.classList.add('animate-fade-in');
  });

  clearGenBtn?.addEventListener('click', () => {
    genList.innerHTML = '';
    genResults.classList.add('hidden');
  });
})();
