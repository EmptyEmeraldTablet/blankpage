<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'

type MemoRow = {
  id: number
  content: string
  created_at: string
  updated_at: string
}

type ClipPayload = {
  text: string | null
  created_at?: string
}

const AUTOSAVE_DELAY_MS = 5000
const REQUEST_TIMEOUT_MS = 10000
const API_BASE = (import.meta.env.VITE_API_BASE || '').trim()
const NORMALIZED_API_BASE = API_BASE.replace(/\/$/, '')

const tokenKey = 'memo_token'
const token = ref<string>(localStorage.getItem(tokenKey) || '')
const loginPassword = ref('')
const authError = ref('')
const isBooting = ref(true)
const isLoading = ref(false)
const isSaving = ref(false)
const memos = ref<MemoRow[]>([])
const selectedId = ref<number | null>(null)
const editorContent = ref('')
const editorDirty = ref(false)
const editorRef = ref<HTMLTextAreaElement | null>(null)
const editorStatus = ref('')
const memoLastSavedContent = ref('')
const memoAutosavePending = ref(false)
const searchQuery = ref('')
const clipText = ref('')
const clipStatus = ref('')
const clipMeta = ref('')
const clipSaving = ref(false)
const clipClearing = ref(false)
const clipAutosaveTimer = ref<number | null>(null)
const clipLastSavedText = ref('')
const clipAutosavePending = ref(false)
const autosaveStatus = ref('')
const autosaveTimer = ref<number | null>(null)

const blockingCount = ref(0)
const isBlocking = computed(() => blockingCount.value > 0)
const selectedMemo = computed(() => memos.value.find((memo) => memo.id === selectedId.value) || null)
const editorCount = computed(() => editorContent.value.trim().length)
const filteredMemos = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return memos.value
  return memos.value.filter((memo) => memo.content.toLowerCase().includes(query))
})

const formatTime = (value?: string) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

const setToken = (value: string) => {
  token.value = value
  if (value) {
    localStorage.setItem(tokenKey, value)
  } else {
    localStorage.removeItem(tokenKey)
  }
}

const buildApiUrl = (path: string) => {
  if (!NORMALIZED_API_BASE) return path
  if (path.startsWith('/')) return `${NORMALIZED_API_BASE}${path}`
  return `${NORMALIZED_API_BASE}/${path}`
}

const withBlocking = async <T,>(task: () => Promise<T>) => {
  blockingCount.value += 1
  try {
    return await task()
  } finally {
    blockingCount.value = Math.max(0, blockingCount.value - 1)
  }
}

const fetchWithTimeout = async (path: string, init: RequestInit = {}) => {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(buildApiUrl(path), { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeoutId)
  }
}

const apiFetch = async (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  if (token.value) {
    headers.set('authorization', `Bearer ${token.value}`)
  }
  const response = await fetchWithTimeout(path, { ...init, headers })
  if (response.status === 401) {
    setToken('')
    throw new Error('unauthorized')
  }
  if (!response.ok) {
    throw new Error(`request_failed:${response.status}`)
  }
  return response
}

const handleAuthError = (error: unknown) => {
  if (error instanceof Error && error.message === 'unauthorized') {
    authError.value = '会话已过期，请重新登录。'
  } else if (error instanceof Error && error.message.startsWith('request_failed')) {
    authError.value = '请求失败，请重试。'
  } else if (error instanceof DOMException && error.name === 'AbortError') {
    authError.value = '请求超时，请重试。'
  } else {
    authError.value = '请求失败，请重试。'
  }
}

const loadMemos = async () => {
  isLoading.value = true
  authError.value = ''
  try {
    const response = await apiFetch('/api/memos')
    const data = (await response.json()) as MemoRow[]
    memos.value = Array.isArray(data) ? data : []
    const first = memos.value[0]
    if (!selectedId.value && first) {
      selectMemo(first)
    }
  } catch (error) {
    handleAuthError(error)
  } finally {
    isLoading.value = false
  }
}

const loadClip = async () => {
  try {
    const response = await apiFetch('/api/clip')
    const data = (await response.json()) as ClipPayload
    clipText.value = data.text ?? ''
    clipMeta.value = data.created_at ? `上次保存 ${formatTime(data.created_at)}` : ''
    clipLastSavedText.value = clipText.value
  } catch (error) {
    handleAuthError(error)
  }
}

const refreshAll = async () => {
  await withBlocking(async () => {
    await Promise.all([loadMemos(), loadClip()])
  })
}

const login = async () => {
  authError.value = ''
  await withBlocking(async () => {
    try {
      const response = await fetchWithTimeout('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: loginPassword.value }),
      })
      if (!response.ok) {
        authError.value = '密码不正确。'
        return
      }
      const data = (await response.json()) as { token?: string }
      if (!data.token) {
        authError.value = '登录失败，未返回令牌。'
        return
      }
      setToken(data.token)
      loginPassword.value = ''
      await refreshAll()
    } catch {
      authError.value = '登录失败，请重试。'
    }
  })
}

const signOut = () => {
  setToken('')
  memos.value = []
  selectedId.value = null
  editorContent.value = ''
  editorDirty.value = false
  editorStatus.value = ''
  memoLastSavedContent.value = ''
  searchQuery.value = ''
  clipText.value = ''
  clipStatus.value = ''
  clipMeta.value = ''
  clipLastSavedText.value = ''
}

const selectMemo = (memo: MemoRow) => {
  selectedId.value = memo.id
  editorContent.value = memo.content
  editorDirty.value = false
  editorStatus.value = ''
  memoLastSavedContent.value = memo.content
}

const startNewMemo = () => {
  selectedId.value = null
  editorContent.value = ''
  editorDirty.value = false
  editorStatus.value = ''
  memoLastSavedContent.value = ''
}

const saveMemo = async (options: { silent?: boolean; fromAutosave?: boolean } = {}) => {
  if (isSaving.value) return
  const content = editorContent.value.trim()
  if (!content) return
  if (options.fromAutosave && content === memoLastSavedContent.value) {
    return
  }
  isSaving.value = true
  if (!options.silent) {
    authError.value = ''
  }
  try {
    if (selectedId.value) {
      const response = await apiFetch(`/api/memos/${selectedId.value}`, {
        method: 'PUT',
        body: JSON.stringify({ content }),
      })
      const data = (await response.json()) as MemoRow
      memos.value = memos.value.map((memo) => (memo.id === data.id ? data : memo))
      selectMemo(data)
    } else {
      if (options.fromAutosave && content.length < 3) {
        return
      }
      const response = await apiFetch('/api/memos', {
        method: 'POST',
        body: JSON.stringify({ content }),
      })
      const data = (await response.json()) as MemoRow
      memos.value = [data, ...memos.value]
      selectMemo(data)
    }
    editorDirty.value = false
    memoLastSavedContent.value = content
    if (options.fromAutosave) {
      autosaveStatus.value = `已自动保存 ${formatTime(new Date().toISOString())}`
    }
    editorStatus.value = options.fromAutosave ? '' : '已保存。'
  } catch (error) {
    if (!options.silent) {
      handleAuthError(error)
    }
  } finally {
    isSaving.value = false
    if (memoAutosavePending.value) {
      memoAutosavePending.value = false
      if (editorDirty.value) {
        scheduleAutosave()
      }
    }
  }
}

const scheduleAutosave = () => {
  if (!token.value) return
  if (isSaving.value) {
    memoAutosavePending.value = true
    return
  }
  if (autosaveTimer.value) {
    clearTimeout(autosaveTimer.value)
  }
  autosaveTimer.value = window.setTimeout(() => {
    if (!editorDirty.value) return
    autosaveStatus.value = ''
    saveMemo({ silent: true, fromAutosave: true })
  }, AUTOSAVE_DELAY_MS)
}

const deleteMemo = async () => {
  if (!selectedId.value) return
  if (!confirm('确定删除该备忘录吗？')) return
  try {
    await apiFetch(`/api/memos/${selectedId.value}`, { method: 'DELETE' })
    memos.value = memos.value.filter((memo) => memo.id !== selectedId.value)
    const first = memos.value[0]
    if (first) {
      selectMemo(first)
    } else {
      startNewMemo()
    }
    editorStatus.value = '已删除。'
  } catch (error) {
    handleAuthError(error)
  }
}

const saveClip = async () => {
  if (clipSaving.value) return
  clipSaving.value = true
  clipStatus.value = ''
  try {
    const response = await apiFetch('/api/clip', {
      method: 'POST',
      body: JSON.stringify({ text: clipText.value }),
    })
    const data = (await response.json()) as ClipPayload
    clipMeta.value = data.created_at ? `上次保存 ${formatTime(data.created_at)}` : ''
    clipStatus.value = '已保存到云剪贴板。'
    clipLastSavedText.value = clipText.value
  } catch (error) {
    handleAuthError(error)
  } finally {
    clipSaving.value = false
    if (clipAutosavePending.value) {
      clipAutosavePending.value = false
      scheduleClipAutosave()
    }
  }
}

const scheduleClipAutosave = () => {
  if (!token.value) return
  if (clipSaving.value) {
    clipAutosavePending.value = true
    return
  }
  if (clipAutosaveTimer.value) {
    clearTimeout(clipAutosaveTimer.value)
  }
  clipAutosaveTimer.value = window.setTimeout(async () => {
    if (clipSaving.value) return
    if (clipText.value === clipLastSavedText.value) return
    clipStatus.value = ''
    try {
      const response = await apiFetch('/api/clip', {
        method: 'POST',
        body: JSON.stringify({ text: clipText.value }),
      })
      const data = (await response.json()) as ClipPayload
      clipMeta.value = data.created_at ? `上次保存 ${formatTime(data.created_at)}` : ''
      clipStatus.value = '已自动保存。'
      clipLastSavedText.value = clipText.value
    } catch (error) {
      handleAuthError(error)
    }
  }, AUTOSAVE_DELAY_MS)
}

const copyClip = async () => {
  clipStatus.value = ''
  if (!clipText.value) return
  try {
    await navigator.clipboard.writeText(clipText.value)
    clipStatus.value = '已复制到剪贴板。'
  } catch {
    clipStatus.value = '复制失败，请允许剪贴板权限。'
  }
}

const pasteClip = async () => {
  clipStatus.value = ''
  try {
    const text = await navigator.clipboard.readText()
    clipText.value = text
    clipStatus.value = '已从剪贴板粘贴。'
    scheduleClipAutosave()
  } catch {
    clipStatus.value = '粘贴失败，请允许剪贴板权限。'
  }
}

const markClipDirty = () => {
  scheduleClipAutosave()
}

const clearClip = async () => {
  if (clipClearing.value) return
  clipClearing.value = true
  clipStatus.value = ''
  try {
    const response = await apiFetch('/api/clip', {
      method: 'POST',
      body: JSON.stringify({ text: '' }),
    })
    const data = (await response.json()) as ClipPayload
    clipText.value = data.text ?? ''
    clipMeta.value = data.created_at ? `上次保存 ${formatTime(data.created_at)}` : ''
    clipStatus.value = '已清空。'
    clipLastSavedText.value = clipText.value
  } catch (error) {
    handleAuthError(error)
  } finally {
    clipClearing.value = false
  }
}

const copyMemo = async () => {
  editorStatus.value = ''
  if (!editorContent.value.trim()) return
  try {
    await navigator.clipboard.writeText(editorContent.value)
    editorStatus.value = '已复制。'
  } catch {
    editorStatus.value = '复制失败。'
  }
}

const pasteMemo = async () => {
  editorStatus.value = ''
  try {
    const text = await navigator.clipboard.readText()
    if (!text) return
    const target = editorRef.value
    if (!target) {
      editorContent.value = `${editorContent.value}${text}`
      markDirty()
      editorStatus.value = '已粘贴。'
      return
    }
    const start = target.selectionStart ?? editorContent.value.length
    const end = target.selectionEnd ?? editorContent.value.length
    const nextValue = `${editorContent.value.slice(0, start)}${text}${editorContent.value.slice(end)}`
    editorContent.value = nextValue
    markDirty()
    await nextTick()
    target.focus()
    const cursor = start + text.length
    target.setSelectionRange(cursor, cursor)
    editorStatus.value = '已粘贴。'
  } catch {
    editorStatus.value = '粘贴失败。'
  }
}

const markDirty = () => {
  editorDirty.value = true
  scheduleAutosave()
}

const onSaveClick = () => {
  saveMemo()
}

const handleShortcut = (event: KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    saveMemo()
  }
}

onMounted(async () => {
  if (token.value) {
    await refreshAll()
  }
  isBooting.value = false
})

onUnmounted(() => {
  if (autosaveTimer.value) {
    clearTimeout(autosaveTimer.value)
  }
  if (clipAutosaveTimer.value) {
    clearTimeout(clipAutosaveTimer.value)
  }
})
</script>

<template>
  <div class="app">
    <div class="background-glow"></div>
    <div v-if="isBlocking" class="global-blocker" role="status" aria-live="polite">
      <div class="global-loading-bar">正在加载后端内容...</div>
    </div>
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">BP</span>
        <div>
          <div class="brand-title">空白页备忘录</div>
          <div class="brand-subtitle">个人备忘录 + 云剪贴板</div>
        </div>
      </div>
      <div class="topbar-actions">
        <button v-if="token" class="ghost-button" @click="refreshAll" :disabled="isLoading">
          刷新
        </button>
        <button v-if="token" class="ghost-button" @click="signOut">退出登录</button>
      </div>
    </header>

    <main v-if="!token && !isBooting" class="auth">
      <div class="auth-card">
        <h1>登录</h1>
        <p class="muted">单用户访问，密码在 Worker 配置中设置。</p>
        <input
          v-model="loginPassword"
          type="password"
          placeholder="输入密码"
          autocomplete="current-password"
          @keyup.enter="login"
        />
        <button class="primary-button" @click="login">进入备忘录</button>
        <p v-if="authError" class="error">{{ authError }}</p>
      </div>
    </main>

    <main v-else class="workspace">
      <section class="panel memos">
        <div class="panel-header">
          <div>
            <h2>备忘录</h2>
            <span class="muted">显示 {{ filteredMemos.length }} / {{ memos.length }}</span>
          </div>
          <button class="ghost-button" @click="startNewMemo">新建</button>
        </div>
        <div class="search-row">
          <input
            v-model="searchQuery"
            class="search-input"
            type="search"
            placeholder="搜索备忘录"
          />
          <button v-if="searchQuery" class="ghost-button" @click="searchQuery = ''">清空</button>
        </div>
        <div v-if="isLoading" class="status">加载中...</div>
        <div v-else class="memo-list">
          <button
            v-for="memo in filteredMemos"
            :key="memo.id"
            class="memo-item"
            :class="{ active: memo.id === selectedId }"
            @click="selectMemo(memo)"
          >
            <div class="memo-content">
              {{ memo.content.slice(0, 80) || '未命名备忘录' }}
            </div>
            <div class="memo-meta">{{ formatTime(memo.updated_at) }}</div>
          </button>
          <p v-if="!filteredMemos.length" class="status muted">
            {{ memos.length ? '没有匹配结果。' : '还没有备忘录。' }}
          </p>
        </div>
      </section>

      <section class="panel editor">
        <div class="panel-header">
          <div>
            <h2>{{ selectedMemo ? '编辑备忘录' : '新建备忘录' }}</h2>
            <span class="muted">
              {{
                selectedMemo
                  ? `更新于 ${formatTime(selectedMemo.updated_at)}`
                  : '按 Ctrl/⌘ + Enter 保存'
              }}
            </span>
          </div>
          <div class="header-actions">
            <button class="ghost-button" @click="pasteMemo">粘贴</button>
            <button class="ghost-button" @click="copyMemo">复制</button>
            <button class="ghost-button" @click="deleteMemo" :disabled="!selectedMemo">
              删除
            </button>
            <button class="primary-button" @click="onSaveClick" :disabled="isSaving || !editorContent.trim()">
              {{ selectedMemo ? '更新' : '保存' }}
            </button>
          </div>
        </div>
        <textarea
          v-model="editorContent"
          ref="editorRef"
          class="editor-input"
          placeholder="写点什么..."
          @input="markDirty"
          @keydown="handleShortcut"
        ></textarea>
        <div class="editor-footer">
          <span v-if="editorDirty" class="muted">有未保存内容</span>
          <span v-else class="muted">已全部保存</span>
          <span v-if="autosaveStatus" class="muted">{{ autosaveStatus }}</span>
          <span v-if="editorStatus" class="muted">{{ editorStatus }}</span>
          <span v-if="authError" class="error">{{ authError }}</span>
          <span class="muted">{{ editorCount }} 字</span>
        </div>
      </section>

      <section class="panel clip">
        <div class="panel-header">
          <div>
            <h2>云剪贴板</h2>
            <span class="muted">{{ clipMeta || 'KV 自动过期' }}</span>
          </div>
        </div>
        <textarea
          v-model="clipText"
          class="clip-input"
          placeholder="在此粘贴临时文本..."
          @input="markClipDirty"
        ></textarea>
        <div class="clip-actions">
          <button class="ghost-button" @click="copyClip">复制到剪贴板</button>
          <button class="ghost-button" @click="pasteClip">从剪贴板粘贴</button>
          <button class="ghost-button" @click="clearClip" :disabled="clipClearing">
            清空
          </button>
          <button class="primary-button" @click="saveClip" :disabled="clipSaving">
            保存剪贴板
          </button>
        </div>
        <p class="status" v-if="clipStatus">{{ clipStatus }}</p>
      </section>
    </main>
  </div>
</template>

<style scoped>
.app {
  position: relative;
  min-height: 100vh;
  padding: 2.5rem clamp(1.5rem, 3vw, 3.5rem);
  display: flex;
  flex-direction: column;
  gap: 2rem;
  color: var(--color-text);
}

.background-glow {
  position: fixed;
  inset: -30vh;
  background:
    radial-gradient(circle at 20% 20%, rgba(255, 200, 122, 0.25), transparent 45%),
    radial-gradient(circle at 80% 10%, rgba(108, 163, 255, 0.22), transparent 55%),
    radial-gradient(circle at 70% 80%, rgba(120, 255, 206, 0.18), transparent 50%);
  z-index: -1;
}

.global-blocker {
  position: fixed;
  inset: 0;
  background: rgba(244, 241, 234, 0.4);
  backdrop-filter: blur(2px);
  display: flex;
  justify-content: center;
  pointer-events: all;
  z-index: 20;
}

.global-loading-bar {
  margin-top: 1.2rem;
  background: rgba(18, 18, 18, 0.85);
  color: #ffffff;
  padding: 0.55rem 1.2rem;
  border-radius: 999px;
  font-size: 0.9rem;
  letter-spacing: 0.02em;
  box-shadow: 0 12px 24px rgba(18, 18, 18, 0.2);
  animation: pulse 1.4s ease-in-out infinite;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
}

.brand {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.brand-mark {
  width: 3rem;
  height: 3rem;
  border-radius: 16px;
  background: linear-gradient(135deg, #ffb347, #6aa6ff);
  color: #121212;
  font-weight: 700;
  display: grid;
  place-items: center;
  font-family: var(--font-display);
  letter-spacing: 0.05em;
}

.brand-title {
  font-family: var(--font-display);
  font-size: 1.2rem;
  letter-spacing: 0.02em;
}

.brand-subtitle {
  font-size: 0.85rem;
  color: var(--color-muted);
}

.topbar-actions {
  display: flex;
  gap: 0.75rem;
}

.auth {
  display: grid;
  place-items: center;
  flex: 1;
}

.auth-card {
  width: min(420px, 100%);
  padding: 2.5rem;
  border-radius: 24px;
  background: var(--color-surface);
  box-shadow: var(--shadow-soft);
  display: grid;
  gap: 1rem;
  animation: float-in 0.6s ease both;
}

.auth-card h1 {
  font-family: var(--font-display);
  font-size: 2rem;
}

.workspace {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) minmax(360px, 2fr) minmax(260px, 1fr);
  gap: 1.5rem;
  align-items: start;
}

.panel {
  background: var(--color-surface);
  border-radius: 20px;
  padding: 1.5rem;
  box-shadow: var(--shadow-soft);
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-height: 420px;
  animation: fade-up 0.5s ease both;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}

.panel-header h2 {
  font-family: var(--font-display);
  font-size: 1.2rem;
}

.search-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.search-input {
  flex: 1;
  border-radius: 999px;
  border: 1px solid rgba(18, 18, 18, 0.12);
  padding: 0.55rem 1rem;
  background: rgba(255, 255, 255, 0.6);
  font-size: 0.9rem;
}

.memo-list {
  display: grid;
  gap: 0.75rem;
  overflow-y: auto;
  padding-right: 0.5rem;
}

.memo-item {
  text-align: left;
  border: 1px solid transparent;
  border-radius: 14px;
  padding: 0.85rem;
  background: var(--color-surface-muted);
  cursor: pointer;
  transition: transform 0.2s ease, border-color 0.2s ease;
}

.memo-item:hover {
  transform: translateY(-2px);
  border-color: rgba(106, 166, 255, 0.4);
}

.memo-item.active {
  border-color: rgba(255, 179, 71, 0.8);
  background: rgba(255, 179, 71, 0.12);
}

.memo-content {
  font-size: 0.95rem;
  line-height: 1.3;
  margin-bottom: 0.35rem;
}

.memo-meta {
  font-size: 0.75rem;
  color: var(--color-muted);
}

.editor {
  min-height: 520px;
}

.editor-input,
.clip-input,
.auth-card input {
  width: 100%;
  border-radius: 14px;
  border: 1px solid rgba(18, 18, 18, 0.1);
  padding: 0.9rem 1rem;
  font-size: 0.95rem;
  background: rgba(255, 255, 255, 0.6);
  font-family: var(--font-body);
  resize: vertical;
}

.editor-input {
  flex: 1;
  min-height: 320px;
}

.editor-footer {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.85rem;
  flex-wrap: wrap;
}

.header-actions {
  display: flex;
  gap: 0.5rem;
}

.clip {
  min-height: 320px;
}

.clip-actions {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.primary-button,
.ghost-button {
  border-radius: 999px;
  border: none;
  padding: 0.6rem 1.4rem;
  font-size: 0.9rem;
  cursor: pointer;
  font-family: var(--font-body);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.primary-button {
  background: linear-gradient(135deg, #ffb347, #ff7a59);
  color: #1f140b;
  box-shadow: 0 10px 20px rgba(255, 122, 89, 0.25);
}

.ghost-button {
  background: rgba(18, 18, 18, 0.08);
  color: var(--color-text);
}

.primary-button:hover,
.ghost-button:hover {
  transform: translateY(-1px);
}

.primary-button:disabled,
.ghost-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

.status {
  font-size: 0.85rem;
}

.muted {
  color: var(--color-muted);
}

.error {
  color: #b13d2d;
}

@media (max-width: 1100px) {
  .workspace {
    grid-template-columns: 1fr;
  }

  .panel {
    min-height: auto;
  }
}

@keyframes fade-up {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes pulse {
  0% {
    opacity: 0.7;
    transform: translateY(0);
  }
  50% {
    opacity: 1;
    transform: translateY(2px);
  }
  100% {
    opacity: 0.7;
    transform: translateY(0);
  }
}

@keyframes float-in {
  from {
    opacity: 0;
    transform: translateY(18px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
