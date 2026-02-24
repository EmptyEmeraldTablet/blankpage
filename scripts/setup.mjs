import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const TEMPLATE_PATH = path.resolve('wrangler.example.jsonc')
const TARGET_PATH = path.resolve('wrangler.jsonc')
const ENV_PATH = path.resolve('.env.local')
const KV_ID_REGEX = /\b[0-9a-f]{32}\b/i
const D1_ID_REGEX = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i

const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx'

const runCommand = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(stderr || stdout || `Command failed: ${command} ${args.join(' ')}`))
      }
    })
  })

const extractId = (regex, text, label) => {
  const match = text.match(regex)
  if (!match) {
    throw new Error(`Could not parse ${label} from output.`)
  }
  return match[0]
}

const escapeJson = (value) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

const askYesNo = async (rl, question, defaultValue = false) => {
  const suffix = defaultValue ? 'Y/n' : 'y/N'
  const answer = (await rl.question(`${question} (${suffix}) `)).trim().toLowerCase()
  if (!answer) return defaultValue
  return answer === 'y' || answer === 'yes'
}

const main = async () => {
  if (!existsSync(TEMPLATE_PATH)) {
    throw new Error('wrangler.example.jsonc not found.')
  }

  const rl = createInterface({ input, output })
  try {
    const shouldOverwrite = existsSync(TARGET_PATH)
      ? await askYesNo(rl, 'wrangler.jsonc exists. Overwrite?', false)
      : true

    if (!shouldOverwrite) {
      console.log('Aborted. Keeping existing wrangler.jsonc.')
      return
    }

    const createResources = await askYesNo(rl, 'Create KV/D1 resources via wrangler now?', false)

    let kvId = ''
    let kvPreviewId = ''
    let d1Id = ''

    if (createResources) {
      console.log('Creating KV namespace MEMO_KV...')
      const kvOutput = await runCommand(npxCommand, ['wrangler', 'kv:namespace', 'create', 'MEMO_KV'])
      kvId = extractId(KV_ID_REGEX, `${kvOutput.stdout}\n${kvOutput.stderr}`, 'KV id')

      console.log('Creating KV preview namespace MEMO_KV...')
      const kvPreviewOutput = await runCommand(npxCommand, [
        'wrangler',
        'kv:namespace',
        'create',
        'MEMO_KV',
        '--preview',
      ])
      kvPreviewId = extractId(KV_ID_REGEX, `${kvPreviewOutput.stdout}\n${kvPreviewOutput.stderr}`, 'KV preview id')

      console.log('Creating D1 database memo_db...')
      const d1Output = await runCommand(npxCommand, ['wrangler', 'd1', 'create', 'memo_db'])
      d1Id = extractId(D1_ID_REGEX, `${d1Output.stdout}\n${d1Output.stderr}`, 'D1 id')
    }

    if (!kvId) {
      kvId = (await rl.question('KV id (MEMO_KV): ')).trim()
    }
    if (!kvPreviewId) {
      kvPreviewId = (await rl.question('KV preview id (MEMO_KV): ')).trim()
    }
    if (!d1Id) {
      d1Id = (await rl.question('D1 database id (memo_db): ')).trim()
    }

    const appPassword = (await rl.question('APP_PASSWORD (leave blank to keep "change-me"): ')).trim()
    const corsOrigins = (await rl.question('CORS_ALLOWED_ORIGINS (default "*"): ')).trim()
    const apiBase = (await rl.question('VITE_API_BASE (optional): ')).trim()

    const template = await readFile(TEMPLATE_PATH, 'utf8')
    const replacements = [
      ['REPLACE_WITH_KV_ID', kvId],
      ['REPLACE_WITH_KV_PREVIEW_ID', kvPreviewId],
      ['REPLACE_WITH_D1_ID', d1Id],
      ['REPLACE_WITH_APP_PASSWORD', escapeJson(appPassword || 'change-me')],
      ['REPLACE_WITH_CORS_ALLOWED_ORIGINS', escapeJson(corsOrigins || '*')],
    ]

    let outputText = template
    for (const [needle, value] of replacements) {
      outputText = outputText.split(needle).join(value)
    }

    await writeFile(TARGET_PATH, outputText)
    console.log('Wrote wrangler.jsonc')

    if (apiBase) {
      await writeFile(ENV_PATH, `VITE_API_BASE=${apiBase}\n`)
      console.log('Wrote .env.local')
    }

    const applyMigrations = await askYesNo(rl, 'Apply local D1 migrations now?', false)
    if (applyMigrations) {
      await runCommand(npxCommand, ['wrangler', 'd1', 'migrations', 'apply', 'memo_db', '--local'])
      console.log('Applied D1 migrations to local DB.')
    }
  } finally {
    rl.close()
  }
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
