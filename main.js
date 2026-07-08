const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const fs = require('fs')

// Root is the parent folder of wherever this app lives
const root = app.isPackaged
  ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath))
  : path.dirname(app.getAppPath())

const configPath = path.join(root, 'pubble-sync-config.json')

function getTemplateName() {
  try {
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      if (cfg.templateFolder) return cfg.templateFolder
    }
  } catch {}

  // Auto-detect: find a folder in root that looks like a Pubble template
  try {
    const folders = fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)

    for (const name of folders) {
      const hasContentCss = fs.existsSync(path.join(root, name, 'dist', 'content.css'))
      const hasReveal     = fs.existsSync(path.join(root, name, 'dist', 'reveal.js'))
      if (hasContentCss && hasReveal) {
        // Save auto-detected template to config
        fs.writeFileSync(configPath, JSON.stringify({ templateFolder: name }, null, 2), 'utf8')
        return name
      }
    }
  } catch {}

  return 'Pubble HTML - New'
}

// Files/folders to EXCLUDE from sync (game-specific — must be set per game)
const SYNC_EXCLUDE = new Set([
  'index.html',
  'last-updated.txt',
  'gulpfile.js',
  'package.json',
  'package-lock.json',
  path.join('dist', 'content.css'),
])

function getTemplateDate(source) {
  if (!fs.existsSync(source)) return 'unknown'
  let newest = null
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (entry.name === 'last-updated.txt') continue
      const mtime = fs.statSync(full).mtime
      if (!newest || mtime > newest) newest = mtime
    }
  }
  walk(source)
  if (!newest) return 'unknown'
  return newest.toISOString().slice(0, 10)
}

function getFolders(source, templateName) {
  if (!fs.existsSync(source)) return []
  const templateDate = getTemplateDate(source)
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== templateName && e.name !== '_Backups' && e.name !== 'pubble-sync-app')
    .map(e => {
      const stampPath = path.join(root, e.name, 'last-updated.txt')
      if (!fs.existsSync(stampPath)) {
        return { name: e.name, lastSynced: null, gameDate: null, status: 'never' }
      }
      const stamp = fs.readFileSync(stampPath, 'utf8')
      const lastSynced = (stamp.match(/Last synced\s*:\s*(.+)/) || [])[1]?.trim() || 'unknown'
      const gameDate   = (stamp.match(/Template ver\s*:\s*(.+)/) || [])[1]?.trim() || 'unknown'
      const status     = gameDate === templateDate ? 'ok' : 'outdated'
      return { name: e.name, lastSynced, gameDate, status }
    })
}

function copyRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) copyRecursive(s, d)
    else fs.copyFileSync(s, d)
  }
}

// Sync everything from src to dst EXCEPT excluded paths
function syncExclusive(src, dst, relBase) {
  let copied = 0
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const relPath = relBase ? path.join(relBase, entry.name) : entry.name
    if (SYNC_EXCLUDE.has(relPath)) continue
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      copied += syncExclusive(s, d, relPath)
    } else {
      fs.mkdirSync(path.dirname(d), { recursive: true })
      fs.copyFileSync(s, d)
      copied++
    }
  }
  return copied
}

function zipFolder(src, dest) {
  const { execSync } = require('child_process')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  execSync(`powershell -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${src}', '${dest}')"`)
}

ipcMain.handle('get-status', () => {
  const templateName = getTemplateName()
  const source = path.join(root, templateName)
  const templateExists = fs.existsSync(source)
  const templateDate = templateExists ? getTemplateDate(source) : null
  const folders = templateExists ? getFolders(source, templateName) : []
  return { templateName, templateDate, folders, templateExists, root }
})

ipcMain.handle('run-sync', async (event, folderNames) => {
  const templateName = getTemplateName()
  const source = path.join(root, templateName)
  const templateDate = getTemplateDate(source)
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
  const fileTimestamp = timestamp.replace(/[: ]/g, '-')
  const results = []

  for (const name of folderNames) {
    const gameFolder = path.join(root, name)
    const result = { name, backed: false, copied: 0, error: null }

    // Backup
    try {
      const backupDir = path.join(root, '_Backups', name)
      fs.mkdirSync(backupDir, { recursive: true })
      zipFolder(gameFolder, path.join(backupDir, `${fileTimestamp}.zip`))
      result.backed = true
    } catch (e) {
      result.error = `Backup failed: ${e.message}`
    }

    // Exclusion-based sync
    result.copied = syncExclusive(source, gameFolder, '')

    // Write last-updated.txt
    fs.writeFileSync(
      path.join(gameFolder, 'last-updated.txt'),
      `Last synced : ${timestamp}\nTemplate ver: ${templateDate}`,
      'utf8'
    )

    results.push(result)
  }

  // Append to log
  const logPath = path.join(root, '_sync-log.txt')
  const logLines = [`[${fileTimestamp}] Sync run - source: ${templateName}`]
  for (const r of results) {
    logLines.push(`  ${r.name} - copied: ${r.copied}${r.error ? ', ERROR: ' + r.error : ''}`)
  }
  logLines.push('')
  fs.appendFileSync(logPath, logLines.join('\n') + '\n', 'utf8')

  return results
})

ipcMain.handle('create-game', (event, gameName) => {
  const templateName = getTemplateName()
  const source = path.join(root, templateName)
  const destination = path.join(root, gameName)
  try {
    if (fs.existsSync(destination)) return { error: `Folder "${gameName}" already exists.` }
    copyRecursive(source, destination)

    // Clear content.css to blank stub
    const contentCss = path.join(destination, 'dist', 'content.css')
    if (fs.existsSync(contentCss)) {
      fs.writeFileSync(contentCss,
        `/* ${gameName} - content.css\n   Add your CSS variables and ::before rules here. */\n\n:root {\n\n}\n`, 'utf8')
    }

    // Clear index.html to stub
    const indexHtml = path.join(destination, 'index.html')
    if (fs.existsSync(indexHtml)) {
      fs.writeFileSync(indexHtml,
        `<!DOCTYPE html>\n<!-- ${gameName}\n     Replace this file with your game slides. -->\n<html lang="en">\n<head><meta charset="UTF-8"><title>${gameName}</title></head>\n<body><p>Replace this index.html with your game slides.</p></body>\n</html>\n`, 'utf8')
    }

    // Remove template-only files
    for (const f of ['version.txt', 'gulpfile.js', 'package.json', 'package-lock.json']) {
      const p = path.join(destination, f)
      if (fs.existsSync(p)) fs.unlinkSync(p)
    }

    // Write last-updated.txt
    const templateDate = getTemplateDate(source)
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
    fs.writeFileSync(
      path.join(destination, 'last-updated.txt'),
      `Last synced : ${timestamp}\nTemplate ver: ${templateDate}`, 'utf8')

    return { success: true }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('change-template', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths.length) return { canceled: true }

  const chosen = path.basename(result.filePaths[0])
  try {
    fs.writeFileSync(configPath, JSON.stringify({ templateFolder: chosen }, null, 2), 'utf8')
    return { templateName: chosen }
  } catch (e) {
    return { error: e.message }
  }
})

function createMainWindow() {
  const win = new BrowserWindow({
    width: 820,
    height: 620,
    resizable: false,
    title: 'Pubble Game Manager',
    backgroundColor: '#0f0f0f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  })
  win.loadFile('index.html')
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win.show())
  return win
}

function createSplashWindow() {
  const splash = new BrowserWindow({
    width: 380,
    height: 240,
    frame: false,
    resizable: false,
    center: true,
    backgroundColor: '#1e1e2e',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  splash.loadFile('splash.html')
  splash.setMenuBarVisibility(false)
  return splash
}

function sendStatus(splash, message, progress) {
  if (!splash.isDestroyed()) {
    splash.webContents.send('update-status', { message, progress })
  }
}

app.whenReady().then(() => {
  const splash = createSplashWindow()

  const openMain = () => {
    setTimeout(() => {
      if (!splash.isDestroyed()) splash.close()
      createMainWindow()
    }, 800)
  }

  autoUpdater.on('checking-for-update', () => {
    sendStatus(splash, 'Checking for updates...')
  })

  autoUpdater.on('update-available', () => {
    sendStatus(splash, 'Update found. Downloading...')
  })

  autoUpdater.on('download-progress', (info) => {
    const pct = Math.round(info.percent)
    sendStatus(splash, `Downloading update... ${pct}%`, pct)
  })

  autoUpdater.on('update-downloaded', () => {
    sendStatus(splash, 'Update ready. Restarting...', 100)
    setTimeout(() => autoUpdater.quitAndInstall(), 1500)
  })

  autoUpdater.on('update-not-available', () => {
    sendStatus(splash, 'Up to date.')
    openMain()
  })

  autoUpdater.on('error', () => {
    sendStatus(splash, 'Could not check for updates.')
    openMain()
  })

  autoUpdater.checkForUpdates()
})

app.on('window-all-closed', () => app.quit())
