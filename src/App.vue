<script setup lang="ts">
import { ref, computed, watch, onUnmounted, type Component } from 'vue'
import { useSDK as useSdkCore } from '@xmov/sdk-core'
import { useASR } from '@xmov/asr'
import { createLLMClient } from '@xmov/llm'
import { SDK_GATEWAY } from './config/credentials'
import { getLayoutMap } from './config/sdk-defaults'
import { STATES } from './config/state-machine'
import { buildSystemPrompt, parseLLMResponse } from './config/llm-prompts'
import { useSDKStore } from './composables/useSDKStore'
import { useStateMachine, type StateName } from './composables/useStateMachine'
import { LLM_API_KEY, LLM_ENDPOINT, ASR_APP_ID, ASR_SECRET_ID, ASR_SECRET_KEY, SDK_APP_ID, SDK_APP_SECRET } from './utils/env'
import type { PickerOption, StateDef } from './config/state-machine'
import AvatarCanvas from './components/AvatarCanvas.vue'
import CredentialModal from './components/CredentialModal.vue'
import SubtitleOverlay from './components/SubtitleOverlay.vue'
import ProgressBar from './components/ProgressBar.vue'
import BottomControlBar from './components/BottomControlBar.vue'
import StatusBanner from './components/StatusBanner.vue'
import ConfigDrawer, { type ConfigValues } from './components/ConfigDrawer.vue'
import WidgetPicker from './components/widgets/WidgetPicker.vue'
import WidgetInput from './components/widgets/WidgetInput.vue'
import WidgetText from './components/widgets/WidgetText.vue'
import WidgetConfirm from './components/widgets/WidgetConfirm.vue'
import type { InputSource } from './types'
import type { SdkLogger } from '@xmov/sdk-core'

// ============ Widget 组件映射 ============
const widgetMap: Record<string, Component> = { picker: WidgetPicker, input: WidgetInput, text: WidgetText, confirm: WidgetConfirm }

// ============ SDK Store ============
const sdkStore = useSDKStore()

// ============ 状态机 ============
const {
  currentState, state, session, appStatus, progressSteps,
  widgetConfigFor, transition, recordRetry, isRetryExhausted, getRetryMessage,
  updateSession, generateReceiptNo,
} = useStateMachine()

// ============ SDK ============
const logger: SdkLogger = { log: console.log, warn: console.warn, error: console.error }
const {
  initSDK, destroy: sdkDestroy,
  isInitialized, isInitializing, downloadProgress, lastInitError,
  getSdk,
} = useSdkCore('#avatar-canvas', logger)

const sdkError = computed(() => lastInitError.value)
const configOpen = ref(false)
// ====== 魔搭预览模式（VITE_MODELSCOPE_PREVIEW=true 时启用弹窗） ======
const isModelScopePreview = import.meta.env.VITE_MODELSCOPE_PREVIEW === 'true'
const isModelScopeMode = (typeof window !== 'undefined' && !!(window as any).__ENV__) || isModelScopePreview

const showCredModal = ref(isModelScopeMode)
const trialExpired = ref(false)
const credConnecting = ref(false)
const credError = ref('')
const TRIAL_SECONDS = Number((typeof window !== 'undefined' && (window as any).__ENV__?.VITE_TRIAL_SECONDS) || 300)
const trialSeconds = Math.max(0, TRIAL_SECONDS)
let _trialTimer = 0

function startTrialTimer() {
  if (trialSeconds <= 0) return
  clearInterval(_trialTimer)
  _trialTimer = window.setInterval(() => {
    clearInterval(_trialTimer)
    sdkDestroy()
    trialExpired.value = true
    showCredModal.value = true
  }, trialSeconds * 1000)
}
const sdkAppId = ref(SDK_APP_ID.value)
const sdkAppSecret = ref(SDK_APP_SECRET.value)
const sdkConfigured = computed(() => !!(sdkAppId.value.trim() && sdkAppSecret.value.trim()))

const configValues = computed<ConfigValues>(() => ({
  sdk: { appId: sdkAppId.value, appSecret: sdkAppSecret.value },
  status: { sdkConfigured: sdkConfigured.value, isInitialized: isInitialized.value, isInitializing: isInitializing.value, downloadProgress: downloadProgress.value },
}))

function applyConfigValues(v: ConfigValues) {
  sdkAppId.value = v.sdk.appId; sdkAppSecret.value = v.sdk.appSecret
}

// ============ ASR ============
const asr = useASR()
const asrAppId = ref(ASR_APP_ID.value)
const asrSecretId = ref(ASR_SECRET_ID.value)
const asrSecretKey = ref(ASR_SECRET_KEY.value)
const asrConfigured = computed(() => !!(asrAppId.value.trim() && asrSecretId.value.trim() && asrSecretKey.value.trim()))
const isRecording = ref(false)

async function handleVoiceStart() {
  if (isRecording.value || !asrConfigured.value) return
  isRecording.value = true
  try {
    await asr.start({
      appId: asrAppId.value.trim(),
      secretId: asrSecretId.value.trim(),
      secretKey: asrSecretKey.value.trim(),
      onResult(text: string, isFinal: boolean) {
        if (isFinal && text.trim()) handleUserInput(text.trim(), 'voice')
      },
    })
  } catch (e) {
    console.error('[ASR] 启动失败:', e)
    isRecording.value = false
    appStatus.value = 'asr_unavailable'
  }
}
function handleVoiceEnd() {
  asr.stop()
  isRecording.value = false
}

// ============ LLM ============
const llmApiKey = ref(LLM_API_KEY.value)
const llmEndpoint = ref(LLM_ENDPOINT.value)
const llmConfigured = computed(() => !!llmApiKey.value.trim())
let _llmClient: ReturnType<typeof createLLMClient> | null = null
const conversationHistory = ref<Array<{ role: string; content: string }>>([])

// Key 变更时重置 client，确保新 Key 生效
watch(llmApiKey, () => { _llmClient = null })

function getLLMClient() {
  if (!_llmClient) {
    _llmClient = createLLMClient({
      apiKey: llmApiKey.value.trim(),
      endpoint: llmEndpoint.value.trim() || undefined,
    })
  }
  return _llmClient
}

// ============ 核心：用户输入收口 ============
function handleUserInput(text: string, source: InputSource, widgetIntent?: string) {
  const def = state.value
  if (def.inputMode === 'none') return

  sdkStore.subtitle.value = `🎤 "${text}"`

  // widget 自带 intent → 直接跳转
  if (source === 'widget' && widgetIntent && STATES[widgetIntent as StateName]) {
    transition(widgetIntent as StateName)
    return
  }

  // 按输入模式分发
  if (def.inputMode === 'regex') return handleRegexInput(def, text)
  if (def.inputMode === 'passthrough') return handlePassthroughInput(def, text)
  handleLLMInput(text)
}

function handleRegexInput(def: StateDef, text: string) {
  if (!def.regexPattern || !def.nextState) return
  const match = text.match(def.regexPattern)
  if (match) {
    let value = match[0]
    if (def.widgetConfig && 'validate' in def.widgetConfig) {
      value = def.widgetConfig.validate === 'cardNo' ? text.replace(/\s/g, '') : value
    }
    applyExtractedData(currentState.value, value)
    transition(def.nextState)
  } else {
    recordRetry()
    if (isRetryExhausted()) {
      sdkStore.subtitle.value = getRetryMessage()
      if (def.retry) transition(def.retry.onFail)
    } else {
      sdkStore.subtitle.value = def.regexErrorMsg || '格式错误，请重新输入'
    }
  }
}

function handlePassthroughInput(def: StateDef, text: string) {
  if (!def.nextState) return
  applyExtractedData(currentState.value, text)
  transition(def.nextState)
}

function trySpeak(text: string) {
  if (isInitialized.value) speakText(text)
}

async function handleLLMInput(text: string) {
  if (!llmConfigured.value) {
    sdkStore.subtitle.value = text
    trySpeak(text)
    if (state.value.nextState) transition(state.value.nextState)
    return
  }

  const client = getLLMClient()
  const systemPrompt = buildSystemPrompt(currentState.value, session)
  conversationHistory.value.push({ role: 'user', content: text })
  // 保留最近 40 条消息，防止内存泄漏
  if (conversationHistory.value.length > 40) conversationHistory.value.splice(0, 2)

  try {
    const res = await client.chat(text, systemPrompt)
    const parsed = parseLLMResponse(res.content)
    if (parsed) {
      sdkStore.subtitle.value = parsed.reply
      conversationHistory.value.push({ role: 'assistant', content: parsed.reply })
      if (parsed.extractedData) updateSession(parsed.extractedData)
      handleLLMIntent(parsed)
    } else {
      sdkStore.subtitle.value = res.content
      trySpeak(res.content)
    }
  } catch {
    const errMsg = 'AI 服务暂时不可用，请稍后重试'
    sdkStore.subtitle.value = errMsg
    trySpeak(errMsg)
  }
}

function handleLLMIntent(parsed: { reply: string; intent: string }) {
  // 校验 intent 是否在白名单内
  const allowed = state.value.llmIntents
  if (allowed && !allowed.includes(parsed.intent) && parsed.intent !== 'stay') {
    trySpeak(parsed.reply) // 只说，不跳转
    return
  }

  if (parsed.intent === 'stay') {
    trySpeak(parsed.reply)
    return
  }
  if (parsed.intent === 'done') {
    updateSession({ receiptNo: generateReceiptNo() })
    trySpeak(STATES['done'].subtitleText)
    transition('done')
    return
  }
  if (STATES[parsed.intent as StateName]) {
    trySpeak(parsed.reply)
    transition(parsed.intent as StateName)
  }
}

function applyExtractedData(stateName: StateName, value: string) {
  switch (stateName) {
    case 'ask_card_no': updateSession({ cardNo: value }); break
    case 'ask_id_no': updateSession({ idNo: value }); break
    case 'ask_reason': updateSession({ reason: value }); break
  }
}

// SDK speak：SDK 自带 speak 打断 speak，无需手动 interrupt
function speakText(text: string) {
  if (!text || !isInitialized.value) return
  const sdk = getSdk()
  if (!sdk) return
  sdk.speak(`<speak>${text}</speak>`, true, true)
}

// Widget 事件处理
function onWidgetSelect(item: PickerOption) { handleUserInput(item.value, 'widget', item.intent) }
function onWidgetSubmit(value: string) { handleUserInput(value, 'widget') }
function onWidgetAction(item: PickerOption) { handleUserInput(item.value, 'widget', item.intent) }
function onTextInput(text: string) { handleUserInput(text, 'text-bar') }

// ============ SDK 生命周期 ============
async function handleInit() {
  const ok = await initSDK({
    containerId: '#avatar-canvas',
    appId: sdkAppId.value.trim(),
    appSecret: sdkAppSecret.value.trim(),
    gatewayServer: SDK_GATEWAY,
    proxyWidget: sdkStore.proxyWidget,
    config: { layout: layoutCache[state.value.layout] },
    onWidgetEvent: (data: any) => {
      if (data?.type === 'subtitle_on' && data?.text) {
        sdkStore.subtitle.value = data.text
      }
    },
    onStatusChange: (status: number) => {
      // SDK status: 0=online, 1=offline
      appStatus.value = status === 1 ? 'network_error' : 'normal'
    },
  })
  if (ok) {
    const def = state.value
    if (def.subtitleText) {
      sdkStore.subtitle.value = def.subtitleText
      speakText(def.subtitleText)
    }
  }
}
function handleDestroy() { sdkDestroy() }

async function onCredentialConnect(appId: string, appSecret: string) {
  credError.value = ''
  credConnecting.value = true
  sdkAppId.value = appId
  sdkAppSecret.value = appSecret
  const ok = await initSDK({
    containerId: '#avatar-canvas',
    appId: appId.trim(),
    appSecret: appSecret.trim(),
    gatewayServer: SDK_GATEWAY,
    proxyWidget: sdkStore.proxyWidget,
    config: { layout: layoutCache[state.value.layout] },
    onWidgetEvent: (data: any) => {
      if (data?.type === 'subtitle_on' && data?.text) {
        sdkStore.subtitle.value = data.text
      }
    },
    onStatusChange: (status: number) => {
      appStatus.value = status === 1 ? 'network_error' : 'normal'
    },
  })
  credConnecting.value = false
  if (ok) {
    sdkStore.subtitle.value = '你好，我是你的数字人助手'
    showCredModal.value = false
    if (!trialExpired.value) startTrialTimer()
  } else {
    credError.value = lastInitError.value || '连接失败，请检查 APP ID 和 APP SECRET 是否正确'
  }
}

// 布局配置缓存，避免每次切换重复创建
const layoutCache = getLayoutMap()

// 布局切换
watch(() => state.value.layout, (layout) => {
  const sdk = getSdk()
  if (isInitialized.value && sdk && layoutCache[layout]) {
    sdk.changeLayout(layoutCache[layout])
  }
})

// 状态变化时更新字幕/播报
watch(currentState, (newState) => {
  const def = STATES[newState]
  if (isInitialized.value && def.subtitleText) {
    sdkStore.subtitle.value = def.subtitleText
    speakText(def.subtitleText)
  }
})

// ============ Widget 配置 ============
const currentWidgetConfig = computed(() => widgetConfigFor(currentState.value))
const widgetComponent = computed(() => {
  if (!state.value.widgetType) return null
  return widgetMap[state.value.widgetType] ?? null
})

onUnmounted(() => { clearInterval(_trialTimer) })

;(window as any).__youlingUi = { showCredModal: () => { showCredModal.value = true } }
</script>

<template>
  <div class="app-root">
    <CredentialModal
      v-if="isModelScopeMode"
      :visible="showCredModal"
      :connecting="credConnecting"
      :error="credError"
      :trial-expired="trialExpired"
      :trial-seconds="trialSeconds"
      @connect="onCredentialConnect"
      @close="showCredModal = false"
    />

    <StatusBanner :status="appStatus" />

    <AvatarCanvas
      :layout="state.layout"
      :is-ready="isInitialized"
      :is-loading="isInitializing"
      :progress="downloadProgress"
    />

    <!-- 下半屏区域 -->
    <div class="main-area">
      <!-- Widget 叠层 -->
      <div v-if="widgetComponent && currentWidgetConfig" class="widget-layer" :class="state.layout">
        <component
          :is="widgetComponent"
          v-bind="currentWidgetConfig"
          @select="onWidgetSelect"
          @submit="onWidgetSubmit"
          @action="onWidgetAction"
        />
      </div>

      <SubtitleOverlay />
    </div>

    <div class="bottom-area">
      <ProgressBar :steps="progressSteps" />
      <BottomControlBar
        :disabled="!isInitialized || state.inputMode === 'none'"
        :recording="isRecording"
        :asr-disabled="!asrConfigured || appStatus === 'asr_unavailable'"
        @ptt-start="handleVoiceStart"
        @ptt-end="handleVoiceEnd"
        @text="onTextInput"
      />
    </div>

    <ConfigDrawer
      :is-model-scope="isModelScopeMode"
      :open="configOpen"
      :values="configValues"
      :sdk-error="sdkError"
      @update:open="configOpen = $event"
      @update:values="applyConfigValues"
      @init="handleInit"
      @destroy="handleDestroy"
    />
  </div>
</template>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #app {
  height: 100%;
  overflow: hidden;
  -webkit-tap-highlight-color: transparent;
  -webkit-text-size-adjust: 100%;
}
body {
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: #e8e8ed; color: #1a1a1a;
  display: flex; justify-content: center; align-items: center;
}
#app { width: 100%; max-width: 430px; }

/* 隐藏 SDK 内置字幕渲染 */
#avatar-canvas div[class*="subtitle"],
#avatar-canvas [class*="Subtitle"] { display: none !important; }
</style>

<style scoped>
.app-root {
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: linear-gradient(180deg, #fafafa 0%, #f0f0f5 100%);
  position: relative;
}

/* 下半屏：flex-1 自动填满，包含 widget + 字幕 */
.main-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
}

.widget-layer {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 12px 16px;
  z-index: 10;
}
.widget-layer.pip {
  display: flex;
  align-items: center;
  justify-content: center;
  overflow-y: visible;
}
.widget-layer.pip > :deep(*) {
  width: 100%;
  max-width: 340px;
}

/* 底部控件：固定在底部 + 安全区适配 */
.bottom-area {
  flex-shrink: 0;
  padding-bottom: env(safe-area-inset-bottom, 8px);
  z-index: 50;
}
</style>
