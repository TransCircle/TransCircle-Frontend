// Fetch approved submissions and render them

const CATEGORIES = ['全部', '个人经历', '观点评论', '资源指南']
let submissions = []
let activeCategory = '全部'

async function load() {
  try {
    const res = await fetch('/data/submissions.json')
    submissions = await res.json()
  } catch {
    submissions = []
  }
  renderFilters()
  renderGrid()
}

function renderFilters() {
  const nav = document.getElementById('filterNav')
  const counts = {}
  for (const s of submissions) {
    counts[s.category] = (counts[s.category] || 0) + 1
  }
  counts['全部'] = submissions.length

  nav.innerHTML = CATEGORIES.filter((c) => c === '全部' || counts[c]).map(
    (cat) =>
      `<button class="filterBtn ${cat === activeCategory ? 'active' : ''}" data-cat="${cat}">
        ${cat}${counts[cat] ? ` (${counts[cat]})` : ''}
      </button>`,
  ).join('')

  nav.querySelectorAll('.filterBtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeCategory = btn.dataset.cat
      renderFilters()
      renderGrid()
    })
  })
}

function renderGrid() {
  const grid = document.getElementById('storyGrid')
  const filtered =
    activeCategory === '全部'
      ? submissions
      : submissions.filter((s) => s.category === activeCategory)

  if (filtered.length === 0) {
    grid.innerHTML = '<p class="empty">暂无故事</p>'
    return
  }

  grid.innerHTML = filtered.map(storyCard).join('')
}

function storyCard(s) {
  const authorDisplay =
    s.author_type === 'anonymous'
      ? '匿名'
      : s.author_name || '匿名'

  // Handle both Unix-ms timestamps and ISO strings
  const date = s.created_at
    ? (typeof s.created_at === 'number' || !s.created_at.includes('-')
        ? new Date(typeof s.created_at === 'string' ? Number(s.created_at) : s.created_at).toISOString().slice(0, 10)
        : s.created_at.slice(0, 10))
    : ''

  // Truncate content for preview (first 200 chars)
  const preview = s.content
    ?.replace(/[#*`>\[\]()]/g, '')
    .slice(0, 200) || ''

  return `
    <article class="card" id="s-${s.id}">
      <span class="cardCategory">${s.category}</span>
      <h2 class="cardTitle">${escapeHtml(s.title)}</h2>
      <p class="cardPreview">${escapeHtml(preview)}...</p>
      <div class="cardMeta">
        <span>${escapeHtml(authorDisplay)}</span>
        <span>${date}</span>
      </div>
      <button class="cardExpand" onclick="toggleStory('${s.id}')">阅读全文</button>
      <div class="cardFull" id="full-${s.id}" hidden>
        <div class="cardContent">${renderMarkdown(s.content)}</div>
        <p class="cardAuthor">
          作者：${escapeHtml(authorDisplay)}${s.author_type !== 'anonymous' ? `（${s.author_type === 'real' ? '实名' : '笔名'}）` : ''}
        </p>
      </div>
    </article>
  `
}

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

function renderMarkdown(md) {
  // Simple markdown rendering (for a full site, use a proper renderer)
  let html = escapeHtml(md || '')
    .replace(/\n## (.+)/g, '<h2>$1</h2>')
    .replace(/\n# (.+)/g, '<h1>$1</h1>')
    .replace(/\n- (.+)/g, '<li>$1</li>')
    .replace(/\n\n/g, '<br><br>')
  return html
}

// Global toggle function
window.toggleStory = function (id) {
  const full = document.getElementById(`full-${id}`)
  const btn = document.querySelector(`#s-${id} .cardExpand`)
  if (full.hidden) {
    full.hidden = false
    btn.textContent = '收起'
  } else {
    full.hidden = true
    btn.textContent = '阅读全文'
  }
}

load()
