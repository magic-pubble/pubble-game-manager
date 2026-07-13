const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const https = require('https')
const os = require('os')
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

// ── SMART MERGE: upgrade a game's index.html to the template's version
// while preserving game-specific customizations (title, styles, scripts, custom slides)

function normalizeHtml(s) {
  return s.replace(/\s+/g, ' ').trim()
}

function getHeadAndRest(html) {
  const end = html.indexOf('</head>')
  if (end === -1) return null
  return { head: html.slice(0, end), rest: html.slice(end) }
}

function getStyleBlocks(html) {
  return html.match(/<style\b[\s\S]*?<\/style>/gi) || []
}

function getInlineScripts(html) {
  // Only inline scripts (no src attribute)
  return (html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [])
    .filter(s => !/^<script\b[^>]*\bsrc\s*=/i.test(s))
}

function getSections(html) {
  return html.match(/<section\b[\s\S]*?<\/section>/gi) || []
}

function getClassAndIdTokens(html) {
  const tokens = new Set()
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    m[1].split(/\s+/).forEach(t => t && tokens.add(t))
  }
  for (const m of html.matchAll(/id="([^"]*)"/g)) {
    if (m[1]) tokens.add(m[1])
  }
  return tokens
}

function mergeIndexHtml(templateHtml, gameHtml) {
  let merged = templateHtml

  // 1. Preserve the game's <title>
  const gameTitle = gameHtml.match(/<title>[\s\S]*?<\/title>/i)
  if (gameTitle) {
    merged = merged.replace(/<title>[\s\S]*?<\/title>/i, gameTitle[0])
  }

  // 2. Preserve the game's <style> blocks in <head> (brand colours + custom CSS)
  const gameParts = getHeadAndRest(gameHtml)
  const mergedParts = getHeadAndRest(merged)
  if (gameParts && mergedParts) {
    const gameStyles = getStyleBlocks(gameParts.head)
    if (gameStyles.length > 0) {
      const templateStyles = getStyleBlocks(mergedParts.head)
      if (templateStyles.length > 0) {
        // Replace the template's first head style with all of the game's styles,
        // remove any extra template head styles
        let head = mergedParts.head.replace(templateStyles[0], gameStyles.join('\n\n\t'))
        for (let i = 1; i < templateStyles.length; i++) head = head.replace(templateStyles[i], '')
        merged = head + mergedParts.rest
      } else {
        merged = mergedParts.head + '\n\t' + gameStyles.join('\n\n\t') + '\n' + mergedParts.rest
      }
    }
  }

  // 3. Preserve game-specific inline <script>s in <head> (e.g. custom interactions)
  {
    const gp = getHeadAndRest(gameHtml)
    const mp = getHeadAndRest(merged)
    if (gp && mp) {
      const templateScriptSet = new Set(getInlineScripts(templateHtml).map(normalizeHtml))
      const customHeadScripts = getInlineScripts(gp.head)
        .filter(s => !templateScriptSet.has(normalizeHtml(s)))
      if (customHeadScripts.length > 0) {
        merged = mp.head + '\n\t' + customHeadScripts.join('\n\n\t') + '\n' + mp.rest
      }
    }
  }

  // 4. Preserve custom slides: game <section>s using classes/ids that the
  //    template doesn't know about anywhere (e.g. a custom interactive grid)
  const templateTokens = getClassAndIdTokens(templateHtml)
  const gameSections = getSections(gameHtml)
  const mergedSections = getSections(merged)

  const sectionAnchor = (section) => {
    const m = section.match(/data-trigger-popup="([^"]*)"/)
    return m ? m[1] : null
  }

  for (let i = 0; i < gameSections.length; i++) {
    const section = gameSections[i]
    const tokens = getClassAndIdTokens(section)
    const customTokens = [...tokens].filter(t => !templateTokens.has(t))
    if (customTokens.length === 0) continue

    // Find the nearest preceding game section with a popup trigger that
    // also exists in the merged template — insert the custom slide after it
    let inserted = false
    for (let j = i - 1; j >= 0; j--) {
      const anchor = sectionAnchor(gameSections[j])
      if (!anchor) continue
      const target = mergedSections.find(s => sectionAnchor(s) === anchor)
      if (target) {
        merged = merged.replace(target, target + '\n\n\t\t\t' + section)
        inserted = true
        break
      }
    }
    // Fallback: insert before the closing of the slides container
    if (!inserted) {
      const lastSection = getSections(merged).pop()
      if (lastSection) merged = merged.replace(lastSection, lastSection + '\n\n\t\t\t' + section)
    }
  }

  return merged
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
  return { templateName, templateDate, folders, templateExists, root, version: app.getVersion() }
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

    // Smart-merge index.html: template structure + game customizations
    try {
      const templateIndex = path.join(source, 'index.html')
      const gameIndex = path.join(gameFolder, 'index.html')
      if (fs.existsSync(templateIndex) && fs.existsSync(gameIndex)) {
        const merged = mergeIndexHtml(
          fs.readFileSync(templateIndex, 'utf8'),
          fs.readFileSync(gameIndex, 'utf8')
        )
        fs.writeFileSync(gameIndex, merged, 'utf8')
        result.merged = true
      }
    } catch (e) {
      result.error = `index.html merge failed: ${e.message}`
    }

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

    // Keep template's content.css and index.html (full working game structure).
    // Just personalize the title in index.html.
    const indexHtml = path.join(destination, 'index.html')
    if (fs.existsSync(indexHtml)) {
      let html = fs.readFileSync(indexHtml, 'utf8')
      html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>Pubble! - ${gameName}</title>`)
      fs.writeFileSync(indexHtml, html, 'utf8')
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

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/magic-pubble/pubble-game-manager/releases/latest',
      headers: { 'User-Agent': 'PubbleGameManager' }
    }
    https.get(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

function isNewer(latest, current) {
  const a = latest.replace('v', '').split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true
    if ((a[i] || 0) < (b[i] || 0)) return false
  }
  return false
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      const mod = u.startsWith('https') ? https : require('http')
      mod.get(u, { headers: { 'User-Agent': 'PubbleGameManager' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) { follow(res.headers.location); return }
        const total = parseInt(res.headers['content-length'], 10)
        let received = 0
        const file = fs.createWriteStream(dest)
        res.on('data', chunk => {
          received += chunk.length
          file.write(chunk)
          onProgress(total ? Math.round(received / total * 100) : null, received)
        })
        res.on('end', () => { file.end(); resolve() })
        res.on('error', reject)
      }).on('error', reject)
    }
    follow(url)
  })
}

app.whenReady().then(() => {
  const splash = createSplashWindow()

  const openMain = () => {
    setTimeout(() => {
      if (!splash.isDestroyed()) splash.close()
      createMainWindow()
    }, 800)
  }

  const checkForUpdates = async () => {
    sendStatus(splash, 'Checking for updates...')
    try {
      const release = await fetchLatestRelease()
      const latestVersion = release.tag_name
      const currentVersion = app.getVersion()

      if (!isNewer(latestVersion, currentVersion)) {
        sendStatus(splash, 'Up to date.')
        return openMain()
      }

      const asset = release.assets.find(a => a.name.endsWith('.exe'))
      if (!asset) { sendStatus(splash, 'Could not find update file.'); return openMain() }

      sendStatus(splash, `Update found: ${latestVersion}. Downloading...`, 0)
      const tempPath = path.join(os.tmpdir(), asset.name)
      await downloadFile(asset.browser_download_url, tempPath, (pct, received) => {
        if (pct !== null) sendStatus(splash, `Downloading update... ${pct}%`, pct)
        else sendStatus(splash, `Downloading update... ${(received / 1048576).toFixed(1)} MB`, 50)
      })

      sendStatus(splash, 'Update ready. Restarting...', 100)

      const currentExe = process.env.PORTABLE_EXECUTABLE_FILE
        || (process.env.PORTABLE_EXECUTABLE_DIR
          ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'PubbleGameManager.exe')
          : process.execPath)

      // Retry the copy until the old exe unlocks, then relaunch immediately
      const batPath = path.join(os.tmpdir(), 'pubble-update.bat')
      fs.writeFileSync(batPath, `@echo off\r\n:retry\r\ncopy /y "${tempPath}" "${currentExe}" >nul 2>&1\r\nif errorlevel 1 (\r\n  ping -n 1 -w 300 127.0.0.1 >nul\r\n  goto retry\r\n)\r\nstart "" "${currentExe}"\r\ndel "%~f0"\r\n`)

      // Launch the bat through a VBS wrapper so no console window appears
      const vbsPath = path.join(os.tmpdir(), 'pubble-update-launch.vbs')
      fs.writeFileSync(vbsPath, `CreateObject("WScript.Shell").Run "cmd /c ""${batPath}""", 0, False\r\n`)

      setTimeout(() => {
        const child = require('child_process').spawn('wscript.exe', [vbsPath], {
          detached: true,
          stdio: 'ignore'
        })
        child.unref()
        app.quit()
      }, 600)

    } catch (e) {
      sendStatus(splash, 'Could not check for updates.')
      openMain()
    }
  }

  splash.webContents.once('did-finish-load', checkForUpdates)
})

app.on('window-all-closed', () => app.quit())
