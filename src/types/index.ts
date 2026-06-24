// ========== 会话数据 ==========
export interface SessionData {
  businessType: string
  cardNo: string
  idNo: string
  reason: string
  receiptNo: string
}

// ========== 应用状态 ==========
export type AppStatus = 'normal' | 'network_error' | 'asr_unavailable'

// ========== Widget 项（proxyWidget 渲染用） ==========
export interface WidgetItem {
  id: number
  type: 'image' | 'video' | 'link' | 'model3d' | 'text' | 'audio' | 'subtitle'
  data: Record<string, string>
}

// ========== 用户输入来源 ==========
export type InputSource = 'voice' | 'text-bar' | 'widget'
