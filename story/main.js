// TransCircle Story — fetch approved submissions and render them

// 分类列表从提交数据的 tags[0] 动态提取，"全部"为默认选项
/** @type {Array<{ id: string; title: string; category: string; content: string; author_name: string | null; created_at: number | string }>} */
let submissions = []
let activeCategory = '全部'

// ── Theme System ──────────────────────────────────────

const STORAGE_KEY = 'transcircle-theme'
const THEMES = /** @type {const} */ (['light', 'dark', 'contrast'])
const DEFAULT_THEME = 'light'

function getStoredTheme() {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function getSystemTheme() {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function applyTheme(theme) {
  const value = THEMES.includes(theme) ? theme : DEFAULT_THEME
  document.documentElement.setAttribute('data-theme', value)
}

function initTheme() {
  const stored = getStoredTheme()
  const theme = stored || getSystemTheme()
  applyTheme(theme)
}

// Apply theme before rendering to avoid flash
initTheme()

// ── Data Loading ──────────────────────────────────────

async function load() {
  try {
    const res = await fetch('/v1/public/contributions?limit=100')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    submissions = (body.data || []).map(item => ({
      id: item.id,
      title: item.title,
      category: item.tags?.[0] || '全部',
      content: item.summary || '',
      author_name: item.author?.displayName || null,
      created_at: item.publishedAt,
    }))
  } catch (err) {
    console.error('Failed to load submissions:', err)
    submissions = []
  }
  renderFilters()
  renderGrid()
}

// ── Filter Rendering ──────────────────────────────────

function renderFilters() {
  const nav = document.getElementById('filterNav')
  if (!nav) return

  /** @type {Record<string, number>} */
  const counts = {}
  for (const s of submissions) {
    const cat = s.category
    counts[cat] = (counts[cat] || 0) + 1
  }
  counts['全部'] = submissions.length

  // 从数据中动态提取分类（不依赖硬编码列表）
  const categories = ['全部', ...new Set(submissions.map(s => s.category).filter(c => c !== '全部'))]
  const available = categories.filter(c => c === '全部' || counts[c])

  nav.innerHTML = available.map(cat =>
    `<button class="filterBtn ${cat === activeCategory ? 'active' : ''}" data-cat="${cat}">
      ${cat}${counts[cat] ? ` (${counts[cat]})` : ''}
    </button>`
  ).join('')

  for (const btn of nav.querySelectorAll('.filterBtn')) {
    btn.addEventListener('click', () => {
      const cat = btn.dataset.cat || '全部'
      activeCategory = cat
      renderFilters()
      renderGrid()
    })
  }
}

// ── Grid Rendering ────────────────────────────────────

function renderGrid() {
  const grid = document.getElementById('storyGrid')
  if (!grid) return

  const filtered = activeCategory === '全部'
    ? submissions
    : submissions.filter(s => s.category === activeCategory)

  if (filtered.length === 0) {
    grid.innerHTML = '<p class="empty">暂无故事</p>'
    return
  }

  grid.innerHTML = filtered.map(storyCard).join('')
}

function storyCard(s) {
  const authorDisplay = s.author_name || '匿名'
  const date = formatDate(s.created_at)
  const preview = (s.content || '')
    .replace(/[#*`>\[\]()]/g, '')
    .slice(0, 200)

  return `
    <article class="card" id="s-${html(s.id)}">
      <span class="cardCategory">${html(s.category)}</span>
      <h2 class="cardTitle">${html(s.title)}</h2>
      <p class="cardPreview">${html(preview)}...</p>
      <div class="cardMeta">
        <span>${html(authorDisplay)}</span>
        <span>${html(date)}</span>
      </div>
      <button class="cardExpand" onclick="toggleStory('${html(s.id)}')">阅读全文</button>
      <div class="cardFull" id="full-${html(s.id)}" hidden>
        <div class="cardContent">${renderMarkdown(s.content)}</div>
        <p class="cardAuthor">
          作者：${html(authorDisplay)}
        </p>
      </div>
    </article>
  `
}

// ── Utilities ─────────────────────────────────────────

function formatDate(ts) {
  if (!ts) return ''
  if (typeof ts === 'number' || !ts.includes('-')) {
    const n = typeof ts === 'number' ? ts : Number(ts)
    if (isNaN(n)) return String(ts)
    return new Date(n).toISOString().slice(0, 10)
  }
  return ts.slice(0, 10)
}

/**
 * Escape HTML — MUST be called on ALL user-supplied data before DOM insertion.
 * Uses textContent + innerHTML to let the browser handle escaping correctly.
 * @param {string} str
 * @returns {string}
 */
function html(str) {
  const div = document.createElement('div')
  div.textContent = str
  // The browser's textContent→innerHTML handles & < > but not " and '
  return div.innerHTML
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Render markdown-style formatting to HTML.
 * Security: escapes ALL input first via html(), then applies safe tag replacements.
 * @param {string} md
 * @returns {string}
 */
function renderMarkdown(md) {
  const escaped = html(md || '')
  let result = escaped
    .replace(/\n## (.+)/g, '<h2>$1</h2>')
    .replace(/\n# (.+)/g, '<h1>$1</h1>')
    .replace(/\n- (.+)/g, '<li>$1</li>')
    .replace(/\n\n/g, '<br><br>')
  return result
}

// ── Global ────────────────────────────────────────────

/** @param {string} id */
window.toggleStory = async function (id) {
  const full = document.getElementById(`full-${id}`)
  const btn = document.querySelector(`#s-${id} .cardExpand`)
  if (!full || !btn) return

  if (!full.dataset.loaded) {
    // Fetch full content from detail API (api.md §5.2)
    try {
      const res = await fetch(`/v1/public/contributions/${encodeURIComponent(id)}`)
      if (res.ok) {
        const body = await res.json()
        const contentHtml = body.data?.contentHtml || ''
        const contentEl = full.querySelector('.cardContent')
        if (contentEl) contentEl.innerHTML = contentHtml
      }
    } catch { /* keep summary as fallback */ }
    full.dataset.loaded = '1'
  }
  if (!full || !btn) return

  const wasHidden = full.hidden
  full.hidden = !wasHidden
  btn.textContent = wasHidden ? '收起' : '阅读全文'
}

load()
