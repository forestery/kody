// options.js - Kody v2.4

const get = keys => new Promise(r => chrome.storage.local.get(keys, r));
const set = data  => new Promise(r => chrome.storage.local.set(data, r));

const PAGE_SIZE = 15;
let allWords = [], filtered = [], currentPage = 1, sortBy = 'recent', searchQ = '';

const MILESTONES_LEVELS = [
  { min: 0,   level: '入门阶段',    count: '< 3,000' },
  { min: 10,  level: 'CET-4 预备', count: '3,000–4,000' },
  { min: 30,  level: 'CET-4',      count: '4,000–6,000' },
  { min: 80,  level: 'CET-6',      count: '6,000–8,000' },
  { min: 150, level: '考研水平',    count: '8,000–10,000' },
  { min: 300, level: 'GRE 水平',   count: '10,000+' },
];
function estimateVocab(n) {
  let cur = MILESTONES_LEVELS[0];
  for (const m of MILESTONES_LEVELS) { if (n >= m.min) cur = m; }
  return cur;
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
}
function fmtReview(iso) {
  const d = Math.round((new Date(iso) - Date.now()) / 86400000);
  if (d <= 0)  return { text: '今天', cls: 'review-due' };
  if (d === 1) return { text: '明天', cls: 'review-today' };
  if (d <= 3)  return { text: `${d}天后`, cls: 'review-today' };
  return { text: `${d}天后`, cls: 'review-later' };
}
function fmtTime(iso) {
  const d = new Date(iso);
  return `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch(e) { return url.slice(0,30); }
}

async function load() {
  const data = await get(['learningWords', 'vocabStats']);
  const lw   = data.learningWords || {};
  const vs   = data.vocabStats    || {};

  allWords = Object.entries(lw).map(([word, info]) => ({
    word, trans: info.history?.[0]?.trans || '',
    stage: info.stage ?? 0, nextReview: info.nextReview,
    addedAt: info.addedAt, history: info.history || [],
    count: info.history?.length || 0,
  }));

  const totalSeen = vs.totalTranslated || 0;
  const due = allWords.filter(w => new Date(w.nextReview) <= new Date()).length;

  document.getElementById('stat-total').textContent = allWords.length;
  document.getElementById('stat-due').textContent   = due;
  document.getElementById('stat-seen').textContent  = totalSeen;

  // Vocab estimate card
  const est = estimateVocab(totalSeen);
  const estEl = document.getElementById('vocab-estimate');
  if (totalSeen >= 10) {
    estEl.innerHTML = `
      <div class="vocab-card">
        <div class="vocab-title">📊 你的词汇画像</div>
        <div class="vocab-level">${est.level}</div>
        <div class="vocab-count">预计掌握词汇量约 ${est.count}</div>
        <div class="vocab-note">基于你翻译的 ${totalSeen} 个不同单词推算。双击更多单词，画像会持续更新。</div>
      </div>`;
  } else {
    estEl.innerHTML = '';
  }

  applyFilterSort();
}

function applyFilterSort() {
  const q = searchQ.toLowerCase().trim();
  filtered = q ? allWords.filter(w => w.word.includes(q) || w.trans.includes(q)) : [...allWords];

  filtered.sort((a, b) => {
    if (sortBy === 'alpha')  return a.word.localeCompare(b.word);
    if (sortBy === 'due')    return new Date(a.nextReview) - new Date(b.nextReview);
    if (sortBy === 'count')  return b.count - a.count;
    // recent: by latest history date
    const at = a.history[0]?.date || a.addedAt || '';
    const bt = b.history[0]?.date || b.addedAt || '';
    return bt.localeCompare(at);
  });

  currentPage = 1;
  renderTable();
}

function renderTable() {
  const tbody = document.getElementById('words-tbody');
  tbody.innerHTML = '';

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="6">
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div>${searchQ ? '没有匹配的单词' : '还没有加入学习的单词'}</div>
      </div></td></tr>`;
    document.getElementById('pagination').style.display = 'none';
    return;
  }

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const page = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  page.forEach(item => {
    const { text: rv, cls } = fmtReview(item.nextReview);
    const tr = document.createElement('tr');
    tr.dataset.word = item.word;
    tr.innerHTML = `
      <td><div class="td-word">${item.word}</div></td>
      <td>
        <div class="td-trans">${item.trans || '—'}</div>
        ${item.history.length ? `
          <button class="history-toggle" data-word="${item.word}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            ${item.history.length} 次记录
          </button>
          <div class="history-rows" id="hist-${item.word}">
            ${item.history.map(r => `
              <div class="hist-entry">
                <span class="hist-time">${fmtTime(r.date)}</span>
                <a class="hist-url" href="${r.url}" target="_blank">${hostname(r.url)}</a>
              </div>`).join('')}
          </div>` : ''}
      </td>
      <td><span class="td-cnt">${item.count}次</span></td>
      <td><span class="td-review ${cls}">${rv}</span></td>
      <td><span class="badge-stage">第${item.stage+1}阶</span></td>
      <td><button class="btn-remove" data-word="${item.word}">移除</button></td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.history-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const rows = document.getElementById(`hist-${btn.dataset.word}`);
      const open = rows.classList.toggle('open');
      btn.querySelector('svg').style.transform = open ? 'rotate(0deg)' : '';
      btn.lastChild.textContent = ` ${open ? '收起' : item => item} 记录`;
      // fix text
      const item = filtered.find(f => f.word === btn.dataset.word);
      btn.innerHTML = btn.innerHTML.replace(/\d+ 次记录|收起/, open ? '收起' : `${item?.history.length||0} 次记录`);
    });
  });

  tbody.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const word = btn.dataset.word;
      const cur = await get(['learningWords']);
      const lw  = cur.learningWords || {};
      delete lw[word];
      await set({ learningWords: lw });
      allWords = allWords.filter(w => w.word !== word);
      applyFilterSort();
      document.getElementById('stat-total').textContent = allWords.length;
      toast(`"${word}" 已移除`);
    });
  });

  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  const pg   = document.getElementById('pagination');
  const info = document.getElementById('page-info');
  const btns = document.getElementById('page-btns');
  if (totalPages <= 1) { pg.style.display = 'none'; return; }
  pg.style.display = 'flex';
  const s = (currentPage - 1) * PAGE_SIZE + 1;
  const e = Math.min(currentPage * PAGE_SIZE, filtered.length);
  info.textContent = `第 ${s}–${e} 条，共 ${filtered.length} 条`;
  btns.innerHTML = '';
  const addBtn = (label, page, active = false, disabled = false) => {
    const b = document.createElement('button');
    b.className = 'page-btn' + (active ? ' active' : '');
    b.textContent = label; b.disabled = disabled;
    b.addEventListener('click', () => { currentPage = page; renderTable(); });
    btns.appendChild(b);
  };
  addBtn('‹', currentPage - 1, false, currentPage === 1);
  const pages = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - currentPage) <= 1) pages.push(i);
    else if (pages[pages.length - 1] !== '…') pages.push('…');
  }
  pages.forEach(p => {
    if (p === '…') { const b = document.createElement('button'); b.className='page-btn'; b.textContent='…'; b.disabled=true; btns.appendChild(b); }
    else addBtn(p, p, p === currentPage);
  });
  addBtn('›', currentPage + 1, false, currentPage === totalPages);
}

document.addEventListener('DOMContentLoaded', async () => {
  await load();

  document.querySelectorAll('.nav-item[data-section]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`section-${btn.dataset.section}`).classList.add('active');
    });
  });

  document.getElementById('search-input').addEventListener('input', e => {
    searchQ = e.target.value; applyFilterSort();
  });
  document.getElementById('sort-select').addEventListener('change', e => {
    sortBy = e.target.value; applyFilterSort();
  });

  document.getElementById('reset-learning').addEventListener('click', async () => {
    if (!confirm('确定清除所有学习计划？')) return;
    await set({ learningWords: {}, vocabStats: {} });
    await load(); toast('学习数据已清除');
  });
  document.getElementById('reset-all').addEventListener('click', async () => {
    if (!confirm('确定重置所有数据？不可恢复。')) return;
    await set({ learningWords: {}, vocabStats: {}, userDict: {}, passCardToday: null });
    await load(); toast('所有数据已重置');
  });
});
