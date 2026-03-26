// content.js - Kody v2.4
// 被动学习系统：重逢卡片、情境提示、路过复习、词汇画像

(function () {
  'use strict';
  if (window.__swLoaded) return;
  window.__swLoaded = true;

  // ══════════════════════════════════════════════════════════════════
  //  词典：按首字母懒加载
  // ══════════════════════════════════════════════════════════════════
  const dictCache   = {};
  const dictLoading = {};

  async function getDictForLetter(letter) {
    if (dictCache[letter]) return dictCache[letter];
    if (dictLoading[letter]) return dictLoading[letter];
    dictLoading[letter] = fetch(chrome.runtime.getURL(`wordlists/dict_${letter}.json`))
      .then(r => r.json())
      .then(d => { dictCache[letter] = d; return d; })
      .catch(() => ({}));
    return dictLoading[letter];
  }

  function parseMeanings(raw) {
    if (!raw) return null;
    return raw.split('|').filter(Boolean);
  }

  const LEMMA_RULES = [
    w => w.replace(/ies$/, 'y'),   w => w.replace(/ied$/, 'y'),
    w => w.replace(/ves$/, 'f'),   w => w.replace(/ing$/, 'e'),
    w => w.replace(/ing$/, ''),    w => w.replace(/ings$/, ''),
    w => w.replace(/ed$/, 'e'),    w => w.replace(/ed$/, ''),
    w => w.replace(/s$/, ''),      w => w.replace(/er$/, 'e'),
    w => w.replace(/er$/, ''),     w => w.replace(/est$/, 'e'),
    w => w.replace(/est$/, ''),    w => w.replace(/ly$/, ''),
    w => w.replace(/ly$/, 'le'),   w => w.replace(/tion$/, 'te'),
    w => w.replace(/tion$/, ''),   w => w.replace(/ment$/, ''),
    w => w.replace(/ness$/, ''),   w => w.replace(/ful$/, ''),
    w => w.replace(/able$/, ''),   w => w.replace(/ible$/, ''),
    w => { const m = w.match(/(.+)(.)ing$/); return m && m[2]===m[1].slice(-1) ? m[1] : null; },
    w => { const m = w.match(/(.+)(.)ed$/);  return m && m[2]===m[1].slice(-1) ? m[1] : null; },
  ];

  async function lookupWordAsync(word) {
    const w = word.toLowerCase();
    if (!/^[a-z]/.test(w)) return null;
    const d = await getDictForLetter(w[0]);
    if (!d) return null;
    if (d[w]) return parseMeanings(d[w]);
    for (const rule of LEMMA_RULES) {
      const stem = rule(w);
      if (!stem || stem === w || stem.length < 3) continue;
      const sd = stem[0] === w[0] ? d : await getDictForLetter(stem[0]);
      if (sd?.[stem]) return parseMeanings(sd[stem]);
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════════════
  //  MyMemory API 兜底
  // ══════════════════════════════════════════════════════════════════
  const apiCache = {};
  async function fetchTranslation(word) {
    if (apiCache[word]) return apiCache[word];
    try {
      const resp = await fetch(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=en|zh`,
        { signal: AbortSignal.timeout(6000) }
      );
      const data = await resp.json();
      if (data.responseStatus !== 200) return null;
      const zh = (data.responseData?.translatedText || '')
        .replace(/[^\u4e00-\u9fa5，、。]/g, '').slice(0, 20);
      if (!zh) return null;
      apiCache[word] = zh;
      chrome.storage.local.get(['userDict'], ud => {
        const userDict = ud.userDict || {};
        userDict[word] = zh;
        const l = word[0];
        if (dictCache[l]) dictCache[l][word] = zh;
        chrome.storage.local.set({ userDict });
      });
      return zh;
    } catch (e) { return null; }
  }

  // ══════════════════════════════════════════════════════════════════
  //  领域分类（URL → 领域标签）
  // ══════════════════════════════════════════════════════════════════
  const DOMAIN_MAP = {
    tech:    ['github','stackoverflow','techcrunch','wired','arstechnica','hackernews',
               'news.ycombinator','medium','dev.to','verge','engadget','thenextweb'],
    finance: ['bloomberg','ft.com','wsj','reuters','economist','investopedia',
               'nasdaq','cnbc','marketwatch','seeking'],
    science: ['nature','science','pubmed','arxiv','sciencedaily','newscientist',
               'pnas','cell.com','phys.org'],
    news:    ['nytimes','bbc','cnn','guardian','washingtonpost','apnews',
               'npr','time.com','newsweek'],
    academic:['scholar.google','jstor','ssrn','researchgate','academia.edu','springer'],
  };

  function getDomain(url) {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      for (const [label, patterns] of Object.entries(DOMAIN_MAP)) {
        if (patterns.some(p => host.includes(p))) return label;
      }
    } catch(e) {}
    return null;
  }

  const DOMAIN_LABEL = {
    tech: '科技类', finance: '财经类', science: '科学类',
    news: '新闻类', academic: '学术类',
  };

  // ══════════════════════════════════════════════════════════════════
  //  词汇画像：估算词汇量
  // ══════════════════════════════════════════════════════════════════
  // 里程碑节点（翻译不同词的累计数）
  const MILESTONES = [10, 25, 50, 100, 200, 300, 500];

  // 词汇量估算：根据已翻译词的数量推断
  // 逻辑：用户翻译的词 = 不认识的词，结合查询量估算掌握量
  function estimateVocab(totalTranslated) {
    // 粗略映射（基于 CEFR/CET 研究数据）
    if (totalTranslated < 10)  return null;
    if (totalTranslated < 30)  return { level: 'CET-4 预备', count: '3,000–4,000' };
    if (totalTranslated < 80)  return { level: 'CET-4', count: '4,000–6,000' };
    if (totalTranslated < 150) return { level: 'CET-6', count: '6,000–8,000' };
    if (totalTranslated < 300) return { level: '考研水平', count: '8,000–10,000' };
    return { level: 'GRE 水平', count: '10,000+' };
  }

  // ══════════════════════════════════════════════════════════════════
  //  本地状态
  // ══════════════════════════════════════════════════════════════════
  const INTERVALS = [1, 3, 7, 15, 30, 60];
  let learningWords = {};
  let vocabStats    = { totalTranslated: 0, lastMilestone: 0, streak: 0, lastDate: '' };

  chrome.storage.local.get(['learningWords','userDict','vocabStats'], data => {
    learningWords = data.learningWords || {};
    vocabStats    = data.vocabStats    || { totalTranslated: 0, lastMilestone: 0, streak: 0, lastDate: '' };
    if (data.userDict) {
      for (const [k, v] of Object.entries(data.userDict)) {
        if (dictCache[k[0]]) dictCache[k[0]][k] = v;
      }
    }
  });

  function saveState() {
    chrome.storage.local.set({ learningWords, vocabStats });
  }

  // 记录翻译事件，更新统计
  function recordTranslation(word) {
    const today = new Date().toISOString().slice(0, 10);
    // 连续天数
    if (vocabStats.lastDate !== today) {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      vocabStats.streak = vocabStats.lastDate === yesterday ? (vocabStats.streak || 0) + 1 : 1;
      vocabStats.lastDate = today;
    }
    // 去重计数（同一个词只算一次）
    if (!vocabStats.seenWords) vocabStats.seenWords = {};
    if (!vocabStats.seenWords[word]) {
      vocabStats.seenWords[word] = true;
      vocabStats.totalTranslated = Object.keys(vocabStats.seenWords).length;
    }
    chrome.storage.local.set({ vocabStats });
  }

  // 检查是否触发里程碑
  function checkMilestone() {
    const n = vocabStats.totalTranslated;
    const next = MILESTONES.find(m => m > (vocabStats.lastMilestone || 0) && n >= m);
    if (!next) return null;
    vocabStats.lastMilestone = next;
    const est = estimateVocab(n);
    return est ? { count: n, est } : null;
  }

  // ══════════════════════════════════════════════════════════════════
  //  翻译卡片（重逢卡片）
  // ══════════════════════════════════════════════════════════════════
  let card = null;
  let currentWord  = null;
  let currentTrans = null;

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function getCard() {
    if (card) return card;
    card = document.createElement('div');
    card.id = 'sw-card';
    card.innerHTML = `
      <div id="sw-card-inner">
        <div id="sw-card-header">
          <span id="sw-card-en"></span>
          <button id="sw-card-close">✕</button>
        </div>
        <div id="sw-card-zh"></div>
        <div id="sw-card-reunion"></div>
        <div id="sw-card-actions">
          <button id="sw-btn-learn">★ 加入学习</button>
        </div>
        <div id="sw-card-milestone"></div>
      </div>
      <div id="sw-card-arrow"></div>`;
    document.body.appendChild(card);

    card.querySelector('#sw-card-close').addEventListener('click', e => {
      e.stopPropagation(); hide();
    });
    card.querySelector('#sw-btn-learn').addEventListener('click', e => {
      e.stopPropagation(); e.preventDefault();
      if (!currentWord) return;
      doLearn(currentWord, currentTrans || '');
    });
    document.addEventListener('click', e => {
      if (card && !card.contains(e.target)) hide();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') hide();
    });
    return card;
  }

  function doLearn(word, trans) {
    const ex    = learningWords[word];
    const stage = Math.min((ex?.stage ?? -1) + 1, INTERVALS.length - 1);
    const next  = new Date();
    next.setDate(next.getDate() + INTERVALS[stage]);
    const sentence = captureContext();
    const record = {
      date: new Date().toISOString(), url: location.href,
      title: document.title.slice(0, 80), trans, sentence,
    };
    const history = ex?.history || [];
    const already = history.some(r =>
      r.url === record.url && r.date.slice(0,10) === record.date.slice(0,10)
    );
    learningWords[word] = {
      stage, nextReview: next.toISOString(),
      addedAt: ex?.addedAt || record.date,
      history: already ? history : [record, ...history].slice(0, 50),
    };
    renderCardContent(word, null, true);
    toast(`"${word}" 已加入学习 ★`);
    saveState();
    scheduleHighlight();
  }

  function captureContext() {
    try {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return '';
      const range = sel.getRangeAt(0);
      const text  = range.startContainer.textContent || '';
      const idx   = range.startOffset;
      let s = idx, e = idx;
      while (s > 0 && !/[.!?\n]/.test(text[s-1])) s--;
      while (e < text.length && !/[.!?\n]/.test(text[e])) e++;
      return text.slice(s, Math.min(e+1, s+200)).trim();
    } catch(e) { return ''; }
  }

  function renderCardContent(word, meanings, forceRefresh = false) {
    const c = getCard();
    c.querySelector('#sw-card-en').textContent = word;

    // ── 主释义 ──
    const zhEl = c.querySelector('#sw-card-zh');
    zhEl.style.color = '';
    if (!meanings && !forceRefresh) {
      zhEl.innerHTML = '<span class="sw-loading">查询中…</span>';
    } else if (Array.isArray(meanings) && meanings.length > 0) {
      currentTrans = meanings[0].replace(/^[a-z]+\.\s*/, '');
      if (meanings.length === 1) {
        zhEl.innerHTML = `<span class="sw-zh-single">${esc(meanings[0])}</span>`;
      } else {
        zhEl.innerHTML = meanings.map(m => {
          const pm = m.match(/^([a-z]+\.\s*)/);
          return pm
            ? `<div class="sw-zh-row"><span class="sw-pos">${esc(pm[1].trim())}</span><span class="sw-zh-text">${esc(m.slice(pm[0].length))}</span></div>`
            : `<div class="sw-zh-row"><span class="sw-zh-text">${esc(m)}</span></div>`;
        }).join('');
      }
    } else if (!forceRefresh) {
      zhEl.innerHTML = '<span class="sw-loading">未找到翻译</span>';
    }

    // ── 重逢区（上次情境） ──
    const reunionEl = c.querySelector('#sw-card-reunion');
    const lw = learningWords[word];
    const history = lw?.history || [];

    if (history.length > 0) {
      const last     = history[0];
      const daysAgo  = Math.round((Date.now() - new Date(last.date)) / 86400000);
      const timeStr  = daysAgo === 0 ? '今天' : daysAgo === 1 ? '昨天' : `${daysAgo}天前`;
      let host = '';
      try { host = new URL(last.url).hostname.replace(/^www\./, ''); } catch(e) {}

      // 情境相似性
      const lastDomain = getDomain(last.url);
      const curDomain  = getDomain(location.href);
      const sameField  = lastDomain && curDomain && lastDomain === curDomain;
      const fieldLabel = DOMAIN_LABEL[lastDomain] || '';

      const sentenceHTML = last.sentence
        ? `<div class="sw-reunion-sentence">"${esc(last.sentence.slice(0, 100))}${last.sentence.length > 100 ? '…' : ''}"</div>`
        : '';

      const fieldHTML = sameField && fieldLabel
        ? `<div class="sw-field-match">🎯 上次也是${fieldLabel}，同领域巩固中</div>`
        : '';

      reunionEl.innerHTML = `
        <div class="sw-reunion">
          <div class="sw-reunion-header">
            <span class="sw-reunion-icon">📍</span>
            <span class="sw-reunion-time">${timeStr}</span>
            <a class="sw-reunion-host" href="${esc(last.url)}" target="_blank">${esc(host)}</a>
            ${history.length > 1 ? `<span class="sw-reunion-count">· 共遇到 ${history.length} 次</span>` : ''}
          </div>
          ${sentenceHTML}
          ${fieldHTML}
        </div>`;
    } else {
      reunionEl.innerHTML = '';
    }

    // ── 按钮状态 ──
    const btnLearn = c.querySelector('#sw-btn-learn');
    btnLearn.style.display = '';
    if (lw) {
      const diff = Math.round((new Date(lw.nextReview) - Date.now()) / 86400000);
      const when = diff <= 0 ? '今天复习' : diff === 1 ? '明天复习' : `${diff}天后复习`;
      btnLearn.textContent = `★ 再次学习 · ${when}`;
      btnLearn.className   = 'sw-btn-learned';
    } else {
      btnLearn.textContent = '★ 加入学习';
      btnLearn.className   = '';
    }

    // ── 里程碑徽章 ──
    const msEl = c.querySelector('#sw-card-milestone');
    const ms   = checkMilestone();
    if (ms) {
      msEl.innerHTML = `<div class="sw-milestone">
        🎉 你已翻译 ${ms.count} 个不同单词，词汇量预计已达 <strong>${ms.est.level}</strong>（约 ${ms.est.count} 词）
      </div>`;
    } else {
      msEl.innerHTML = '';
    }
  }

  function positionCard(anchorRect) {
    const c     = getCard();
    const arrow = c.querySelector('#sw-card-arrow');
    const cw    = c.offsetWidth;
    const ch    = c.offsetHeight;
    const gap   = 10;
    let top  = anchorRect.top - ch - gap;
    let left = anchorRect.left + anchorRect.width / 2 - cw / 2;
    if (top < 8) { top = anchorRect.bottom + gap; arrow.className = 'arrow-down'; }
    else { arrow.className = ''; }
    left = Math.max(8, Math.min(left, window.innerWidth - cw - 8));
    c.style.left = left + 'px';
    c.style.top  = top  + 'px';
    c.style.visibility = 'visible';
  }

  function show(word, meanings, anchorRect) {
    currentWord  = word;
    currentTrans = null;
    const c = getCard();
    renderCardContent(word, meanings);
    c.style.visibility = 'hidden';
    c.style.display    = 'block';
    requestAnimationFrame(() => positionCard(anchorRect));
  }

  function hide() {
    if (card) card.style.display = 'none';
    currentWord = null; currentTrans = null;
  }

  // ══════════════════════════════════════════════════════════════════
  //  双击监听
  // ══════════════════════════════════════════════════════════════════
  document.addEventListener('dblclick', async e => {
    const mouseX = e.clientX, mouseY = e.clientY;
    await new Promise(r => setTimeout(r, 10));

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const raw  = sel.toString().trim();
    const word = raw.replace(/[^a-zA-Z'-]/g, '').toLowerCase();
    if (!word || word.length < 2 || !/^[a-z]/.test(word)) return;

    e.stopPropagation();

    let anchor;
    try {
      if (sel.rangeCount > 0) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0)
          anchor = { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width };
      }
    } catch(err) {}
    if (!anchor) anchor = { top: mouseY-4, bottom: mouseY, left: mouseX-30, width: 60 };

    // 立刻显示查询中
    show(word, null, anchor);

    // 记录翻译统计
    recordTranslation(word);

    const meanings = await lookupWordAsync(word);
    if (meanings) {
      renderCardContent(word, meanings);
      requestAnimationFrame(() => positionCard(anchor));
    } else {
      const api = await fetchTranslation(word);
      if (api) {
        renderCardContent(word, [api]);
        requestAnimationFrame(() => positionCard(anchor));
      } else {
        getCard().querySelector('#sw-card-zh').innerHTML =
          '<span class="sw-loading">未找到翻译</span>';
        getCard().querySelector('#sw-btn-learn').style.display = 'none';
      }
    }
  }, true);

  // ══════════════════════════════════════════════════════════════════
  //  随机漫步：高亮已学词（带遇到次数角标）
  // ══════════════════════════════════════════════════════════════════
  const SKIP_TAGS = new Set(['SCRIPT','STYLE','TEXTAREA','INPUT','SELECT',
    'NOSCRIPT','IFRAME','CODE','PRE','SVG','HEAD','BUTTON']);

  let highlightQueued = false;
  function scheduleHighlight() {
    if (highlightQueued) return;
    highlightQueued = true;
    const schedule = window.requestIdleCallback || (cb => setTimeout(cb, 300));
    schedule(() => { highlightQueued = false; highlightBatch(); }, { timeout: 3000 });
  }

  async function highlightBatch() {
    const words = Object.keys(learningWords);
    if (!words.length) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.closest('#sw-card,#sw-review-bar,.sw-highlight,.sw-pass-card'))
          return NodeFilter.FILTER_REJECT;
        if (!node.textContent.trim()) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);

    const escaped = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
    const pattern = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');

    const BATCH = 50;
    for (let i = 0; i < nodes.length; i += BATCH) {
      for (const node of nodes.slice(i, i+BATCH)) {
        if (!node.parentNode) continue;
        const text = node.textContent;
        pattern.lastIndex = 0;
        if (!pattern.test(text)) continue;
        pattern.lastIndex = 0;
        const frag = buildHighlightFrag(text, words);
        if (frag) try { node.parentNode.replaceChild(frag, node); } catch(e) {}
      }
      if (i + BATCH < nodes.length) await new Promise(r => setTimeout(r, 0));
    }
  }

  function buildHighlightFrag(text, words) {
    const hits = [];
    for (const w of words) {
      const re = new RegExp(`\\b(${w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})\\b`, 'gi');
      let m;
      while ((m = re.exec(text)) !== null)
        hits.push({ start: m.index, end: m.index + m[0].length, word: w, original: m[0] });
    }
    if (!hits.length) return null;
    hits.sort((a,b) => a.start - b.start);

    const frag = document.createDocumentFragment();
    let last = 0;
    for (const hit of hits) {
      if (hit.start < last) continue;
      if (hit.start > last) frag.appendChild(document.createTextNode(text.slice(last, hit.start)));

      const span = document.createElement('span');
      span.className = 'sw-highlight';
      span.dataset.word = hit.word;
      span.textContent = hit.original;

      // 遇到次数角标
      const cnt = learningWords[hit.word]?.history?.length || 0;
      if (cnt > 1) {
        const badge = document.createElement('sup');
        badge.className = 'sw-seen-badge';
        badge.textContent = cnt;
        span.appendChild(badge);
      }

      const tip = document.createElement('span');
      tip.className = 'sw-highlight-tip';
      tip.textContent = learningWords[hit.word]?.history?.[0]?.trans
        || dictCache[hit.word[0]]?.[hit.word]?.split('|')[0]?.replace(/^[a-z]+\.\s*/,'')
        || '';
      span.appendChild(tip);
      frag.appendChild(span);
      last = hit.end;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  // ══════════════════════════════════════════════════════════════════
  //  路过复习：小卡片（自动消失，无需操作）
  // ══════════════════════════════════════════════════════════════════
  let passCardShown = false;

  async function checkPassCard() {
    if (passCardShown) return;
    const today = new Date().toISOString().slice(0, 10);
    const data  = await new Promise(r =>
      chrome.storage.local.get(['learningWords','passCardToday'], r)
    );
    learningWords = data.learningWords || learningWords;

    // 今天已展示过几次
    const todayCount = (data.passCardToday?.date === today) ? data.passCardToday.count : 0;
    if (todayCount >= 3) return;  // 每天最多3次路过复习

    const due = Object.entries(learningWords)
      .filter(([, v]) => new Date(v.nextReview) <= new Date());
    if (!due.length) return;

    // 随机挑一个到期词
    const [word, info] = due[Math.floor(Math.random() * due.length)];
    const trans = info.history?.[0]?.trans || '';
    const sentence = info.history?.[0]?.sentence || '';

    passCardShown = true;
    showPassCard(word, trans, sentence);

    chrome.storage.local.set({
      passCardToday: { date: today, count: todayCount + 1 }
    });
  }

  function showPassCard(word, trans, sentence) {
    if (document.getElementById('sw-pass-card')) return;

    const card = document.createElement('div');
    card.id = 'sw-pass-card';

    const sentHTML = sentence
      ? `<div class="sw-pass-sentence">"${esc(sentence.slice(0,80))}${sentence.length>80?'…':''}"</div>`
      : '';

    card.innerHTML = `
      <div class="sw-pass-inner">
        <div class="sw-pass-top">
          <span class="sw-pass-word">${esc(word)}</span>
          <span class="sw-pass-trans">${esc(trans)}</span>
        </div>
        ${sentHTML}
        <div class="sw-pass-actions">
          <button class="sw-pass-btn sw-pass-yes">✓ 记得</button>
          <button class="sw-pass-btn sw-pass-no">✗ 忘了</button>
        </div>
        <div class="sw-pass-bar"><div class="sw-pass-progress"></div></div>
      </div>`;
    document.body.appendChild(card);

    // 进度条动画
    const progress = card.querySelector('.sw-pass-progress');
    requestAnimationFrame(() => { progress.style.width = '0%'; });

    // 5秒后自动消失（不影响记忆曲线）
    const timer = setTimeout(() => fadeOut(card), 5000);
    progress.style.transition = 'width 5s linear';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      progress.style.width = '100%';
    }));

    card.querySelector('.sw-pass-yes').addEventListener('click', () => {
      clearTimeout(timer);
      advanceStage(word);
      toast(`"${word}" ✓ 记忆巩固`);
      fadeOut(card);
    });
    card.querySelector('.sw-pass-no').addEventListener('click', () => {
      clearTimeout(timer);
      // 忘了 → 重置到第一阶段
      if (learningWords[word]) {
        learningWords[word].stage = 0;
        learningWords[word].nextReview = new Date().toISOString();
        saveState();
      }
      fadeOut(card);
    });
  }

  function fadeOut(el) {
    el.style.transition = 'opacity 0.4s ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 400);
  }

  function advanceStage(word) {
    const ex = learningWords[word];
    if (!ex) return;
    const stage = Math.min((ex.stage ?? 0) + 1, INTERVALS.length - 1);
    const next  = new Date();
    next.setDate(next.getDate() + INTERVALS[stage]);
    learningWords[word] = { ...ex, stage, nextReview: next.toISOString() };
    saveState();
  }

  // ══════════════════════════════════════════════════════════════════
  //  Toast
  // ══════════════════════════════════════════════════════════════════
  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'sw-toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  // ══════════════════════════════════════════════════════════════════
  //  启动
  // ══════════════════════════════════════════════════════════════════
  function boot() {
    setTimeout(() => {
      highlightBatch();
      checkPassCard();
    }, 1200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})();
