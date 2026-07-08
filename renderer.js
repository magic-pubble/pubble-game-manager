let allFolders = []
let isDark = false

document.getElementById('theme-switch').addEventListener('click', () => {
  isDark = !isDark
  const sw = document.getElementById('theme-switch')
  document.body.classList.toggle('dark-mode', isDark)
  document.body.classList.toggle('light-mode', !isDark)
  sw.classList.toggle('dark-active', isDark)
})

// Default: light mode, knob on left (sun)
document.body.classList.add('light-mode')

// ── NAVIGATION ──
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'))
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
    item.classList.add('active')
    document.getElementById(`page-${item.dataset.page}`).classList.add('active')
  })
})

// ── LOAD STATUS ──
async function load() {
  const { templateName, templateDate, folders, templateExists, root } = await window.api.getStatus()

  document.getElementById('sidebar-scan-path').textContent = root || '—'
  document.getElementById('sidebar-tpl-name').textContent = templateExists ? templateName : 'Not found'
  document.getElementById('sidebar-tpl-date').textContent = (templateDate && templateDate !== 'unknown') ? formatDate(templateDate) : '—'

  allFolders = folders
  renderFolders(folders)
  updateStats(folders)
  updateSyncBtn()
}

function formatDate(iso) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-NZ', { year: 'numeric', month: 'long', day: 'numeric' })
}

// ── STATS ──
function updateStats(folders) {
  document.getElementById('count-ok').textContent       = folders.filter(f => f.status === 'ok').length
  document.getElementById('count-outdated').textContent = folders.filter(f => f.status === 'outdated').length
  document.getElementById('count-never').textContent    = folders.filter(f => f.status === 'never').length
}

// ── FOLDER LIST ──
function renderFolders(folders) {
  const list = document.getElementById('folder-list')
  if (folders.length === 0) {
    list.innerHTML = '<div class="empty">No game folders found in this directory.</div>'
    return
  }

  list.innerHTML = folders.map((f, i) => {
    const statusLabel = f.status === 'ok' ? 'Up to date' : f.status === 'outdated' ? 'Outdated' : 'Never synced'
    const statusClass = `status-${f.status === 'ok' ? 'ok' : f.status === 'outdated' ? 'outdated' : 'never'}`
    return `
      <div class="folder-row row-${f.status}" data-index="${i}">
        <input type="checkbox" id="cb-${i}">
        <div class="folder-name">${f.name}</div>
        <div class="folder-date">${f.lastSynced || '—'}</div>
        <span class="status-pill ${statusClass}">${statusLabel}</span>
      </div>`
  }).join('')

  document.querySelectorAll('.folder-row').forEach(row => {
    const i = parseInt(row.dataset.index)
    const cb = document.getElementById(`cb-${i}`)

    cb.addEventListener('change', () => {
      row.classList.toggle('selected', cb.checked)
      updateSyncBtn()
    })

    row.addEventListener('click', e => {
      if (e.target === cb) return
      cb.checked = !cb.checked
      row.classList.toggle('selected', cb.checked)
      updateSyncBtn()
    })
  })
}

function updateSyncBtn() {
  const checked = document.querySelectorAll('input[type=checkbox]:checked').length
  const btn = document.getElementById('sync-btn')
  btn.disabled = checked === 0
  btn.textContent = checked > 0 ? `Sync ${checked} Folder${checked > 1 ? 's' : ''}` : 'Sync Selected'
}

// ── SELECT ALL ──
document.getElementById('select-all-btn').addEventListener('click', () => {
  const checkboxes = document.querySelectorAll('input[type=checkbox]')
  const allChecked = [...checkboxes].every(cb => cb.checked)
  checkboxes.forEach((cb, i) => {
    cb.checked = !allChecked
    document.querySelector(`.folder-row[data-index="${i}"]`).classList.toggle('selected', !allChecked)
  })
  document.getElementById('select-all-btn').classList.toggle('all-checked', !allChecked)
  updateSyncBtn()
})

// ── SYNC ──
document.getElementById('sync-btn').addEventListener('click', async () => {
  const selected = [...document.querySelectorAll('input[type=checkbox]:checked')]
    .map(cb => allFolders[parseInt(cb.id.replace('cb-', ''))].name)
  if (selected.length === 0) return

  const overlay    = document.getElementById('overlay')
  const box        = document.getElementById('progress-box')
  const title      = document.getElementById('overlay-title')
  const spinner    = document.getElementById('overlay-spinner')
  const closeBtn   = document.getElementById('close-btn')

  overlay.classList.add('active')
  box.innerHTML = ''
  spinner.style.display = 'block'
  closeBtn.style.display = 'none'
  title.textContent = 'Syncing...'

  const log = (msg, cls = '') => {
    const line = document.createElement('div')
    line.className = `progress-line ${cls}`
    line.textContent = msg
    box.appendChild(line)
    box.scrollTop = box.scrollHeight
  }

  log(`Backing up ${selected.length} folder${selected.length > 1 ? 's' : ''} and syncing...`)

  const results = await window.api.runSync(selected)

  box.innerHTML = ''
  let allOk = true
  for (const r of results) {
    if (r.error) {
      log(`✗ ${r.name} — ${r.error}`, 'err')
      allOk = false
    } else {
      log(`✓ ${r.name} — copied ${r.copied} files, backed up`, 'ok')
    }
  }

  log('')
  log(allOk ? 'All done!' : 'Done with some errors.', allOk ? 'ok' : 'err')

  spinner.style.display = 'none'
  title.textContent = allOk ? 'Sync Complete ✓' : 'Done (with errors)'
  closeBtn.style.display = 'inline-block'

  await load()
})

document.getElementById('close-btn').addEventListener('click', () => {
  document.getElementById('overlay').classList.remove('active')
})

// ── NEW GAME ──
const gameNameInput  = document.getElementById('game-name-input')
const createBtn      = document.getElementById('create-btn')
const previewTree    = document.getElementById('preview-tree')
const formCard       = document.getElementById('new-game-form')
const successCard    = document.getElementById('success-card')

gameNameInput.addEventListener('input', () => {
  const val = gameNameInput.value.trim()
  createBtn.disabled = val.length === 0

  if (!val) {
    previewTree.innerHTML = '<span class="dim">Enter a name above to see a preview</span>'
    document.getElementById('manual-notice').style.display = 'none'
    return
  }

  previewTree.innerHTML = `<span class="highlight">📁 ${val}/</span>
<span class="dim">├── </span><span class="manual">index.html ✏</span>
<span class="dim">├── </span>dist/
<span class="dim">│   ├── </span><span class="manual">content.css ✏</span>
<span class="dim">│   ├── </span>reveal.js
<span class="dim">│   └── </span>pubble.css <span class="dim">... +more</span>
<span class="dim">├── </span>assets/
<span class="dim">│   └── </span>backgrounds, images, other/
<span class="dim">├── </span>fonts/
<span class="dim">└── </span>plugin/`

  document.getElementById('manual-notice').style.display = 'block'
})

createBtn.addEventListener('click', async () => {
  const name = gameNameInput.value.trim()
  if (!name) return

  createBtn.disabled = true
  createBtn.textContent = 'Creating...'

  const result = await window.api.createGame(name)

  if (result.error) {
    createBtn.disabled = false
    createBtn.textContent = 'Create Game Folder'
    alert(`Error: ${result.error}`)
    return
  }

  formCard.style.display = 'none'
  successCard.style.display = 'block'
  document.getElementById('success-title').textContent = `"${name}" created!`
  document.getElementById('success-desc').textContent = `Your new game folder is ready inside the Pubble folder. Here's what to do next:`

  await load()
})

function resetNewGameForm() {
  successCard.style.display = 'none'
  formCard.style.display = 'block'
  gameNameInput.value = ''
  previewTree.innerHTML = '<span class="dim">Enter a name above to see a preview</span>'
  document.getElementById('manual-notice').style.display = 'none'
  createBtn.disabled = true
  createBtn.textContent = 'Create Game Folder'
}

document.getElementById('create-another-btn').addEventListener('click', resetNewGameForm)

document.getElementById('done-btn').addEventListener('click', () => {
  resetNewGameForm()
})

document.getElementById('change-template-btn').addEventListener('click', async () => {
  const result = await window.api.changeTemplate()
  if (result && result.templateName) {
    await load()
  }
})

load()

// ── TUTORIAL ──
const tutorialSteps = [
  {
    targetId: 'change-template-btn',
    title: 'Set Your Template',
    text: 'Click ⇄ to pick your template folder — the master copy that all game folders will sync from. Do this first before syncing.'
  },
  {
    targetSelector: '.nav-item[data-page="sync"]',
    title: 'Sync Games',
    text: 'Select game folders and hit Sync. Shared files from your template (everything except <b>index.html</b> and <b>content.css</b>) are copied into each selected folder. A backup is made first.'
  },
  {
    targetSelector: '.nav-item[data-page="newgame"]',
    title: 'New Game',
    text: "Create a new game folder copied from the template. Shared files come ready to use. You just need to fill in the game-specific ones: <b>index.html</b> and <b>content.css</b>."
  }
]

let tutorialStep = 0

function getTutorialTarget(step) {
  return step.targetId
    ? document.getElementById(step.targetId)
    : document.querySelector(step.targetSelector)
}

function positionTutorialStep() {
  const step = tutorialSteps[tutorialStep]
  const el = getTutorialTarget(step)
  const rect = el.getBoundingClientRect()
  const pad = 4

  const spotlight = document.getElementById('tutorial-spotlight')
  spotlight.style.left   = (rect.left - pad) + 'px'
  spotlight.style.top    = (rect.top  - pad) + 'px'
  spotlight.style.width  = (rect.width  + pad * 2) + 'px'
  spotlight.style.height = (rect.height + pad * 2) + 'px'

  document.getElementById('tutorial-step-num').textContent = `${tutorialStep + 1} of ${tutorialSteps.length}`
  document.getElementById('tutorial-title').textContent = step.title
  document.getElementById('tutorial-text').innerHTML  = step.text

  const tooltip = document.getElementById('tutorial-tooltip')
  const tooltipLeft = rect.right + pad + 18
  let tooltipTop = rect.top + rect.height / 2 - 85
  tooltipTop = Math.max(16, Math.min(tooltipTop, window.innerHeight - 200))
  tooltip.style.left = tooltipLeft + 'px'
  tooltip.style.top  = tooltipTop  + 'px'

  // Point arrow at the center of the target element
  const targetCenterY = rect.top + rect.height / 2
  const arrowTop = targetCenterY - tooltipTop
  tooltip.style.setProperty('--arrow-top', arrowTop + 'px')

  document.getElementById('tutorial-prev').disabled = tutorialStep === 0
  document.getElementById('tutorial-next').textContent =
    tutorialStep === tutorialSteps.length - 1 ? '✓' : '›'
}

function showTutorial(startStep = 0) {
  tutorialStep = startStep
  document.getElementById('tutorial-overlay').style.display = 'block'
  positionTutorialStep()
}

function closeTutorial() {
  document.getElementById('tutorial-overlay').style.display = 'none'
  localStorage.setItem('pubble-tutorial-seen', '1')
}

document.getElementById('tutorial-next').addEventListener('click', () => {
  if (tutorialStep < tutorialSteps.length - 1) {
    tutorialStep++
    positionTutorialStep()
  } else {
    closeTutorial()
  }
})

document.getElementById('tutorial-prev').addEventListener('click', () => {
  if (tutorialStep > 0) {
    tutorialStep--
    positionTutorialStep()
  }
})

document.getElementById('tutorial-dismiss').addEventListener('click', closeTutorial)
document.getElementById('btn-lightbulb').addEventListener('click', () => showTutorial(0))

if (!localStorage.getItem('pubble-tutorial-seen')) setTimeout(() => showTutorial(0), 400)
