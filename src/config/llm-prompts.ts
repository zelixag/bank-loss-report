import type { StateName } from './state-machine'
import type { SessionData } from '../types'

export function buildSystemPrompt(state: StateName, session: SessionData): string {
  const progressText = getProgressSummary(state, session)

  return `你是银行挂失导办智能助手。你在电话里帮助用户办理银行卡挂失业务。

## 当前进度
${progressText}

## 你的职责
1. 引导用户完成挂失流程：选择业务类型 → 收集卡号 → 收集身份证号 → 了解原因 → 确认信息 → 提交
2. 对用户的每句话做出自然、友好的回复
3. 从用户的话中识别意图，提取关键数据

## 当前需要做的事
${getCurrentTask(state)}

## 规则
- 你只支持银行卡挂失。存折、支票挂失告知用户暂不支持
- 卡号必须是 16-19 位纯数字（用户可能用空格或横线分隔）
- 身份证必须是 18 位
- 校验失败时礼貌请用户重新输入，最多重试 2 次
- 用户说"修改"、"重来"、"不对"时，回到相应步骤
- 用户说"取消"、"不挂了"时，确认后结束流程
- 保持简洁，每句话不超过 50 字

## 回复格式（严格 JSON）
{
  "reply": "你对用户说的话（自然语言）",
  "intent": "意图，如 ask_card_no / ask_id_no / ask_reason / confirm / done / welcome / unsupported / stay",
  "extractedData": {
    "businessType": "提取到的业务类型或 null",
    "cardNo": "提取到的卡号纯数字或 null",
    "idNo": "提取到的身份证号或 null",
    "reason": "提取到的挂失原因或 null"
  }
}`
}

// 防止用户输入中的特殊字符破坏 LLM prompt 结构
function escapeForPrompt(s: string): string {
  const escaped = s.replace(/[`{}\\"']/g, '\\$&').replace(/[\n\r\t]/g, ' ')
  return escaped.length > 500 ? escaped.slice(0, 500) + '...(truncated)' : escaped
}

function getProgressSummary(state: StateName, session: SessionData): string {
  const lines: string[] = []
  if (session.businessType) lines.push(`- 业务类型：${escapeForPrompt(session.businessType)}`)
  if (session.cardNo) lines.push(`- 银行卡号：${escapeForPrompt(session.cardNo)}`)
  if (session.idNo) lines.push(`- 身份证号：${escapeForPrompt(session.idNo)}`)
  if (session.reason) lines.push(`- 挂失原因：${escapeForPrompt(session.reason)}`)
  lines.push(`- 当前步骤：${state}`)
  return lines.length > 0 ? lines.join('\n') : '暂无已收集信息'
}

function getCurrentTask(state: StateName): string {
  switch (state) {
    case 'welcome':
      return '询问用户要办理什么业务（银行卡挂失/存折挂失/支票挂失）。用户选择银行卡则进入下一步，其他告知不支持。'
    case 'ask_card_no':
      return '请用户提供 16-19 位银行卡号。如果用户已提供但格式不对，友好提示重新输入。'
    case 'ask_id_no':
      return '请用户提供 18 位身份证号。如果用户已提供但格式不对，友好提示重新输入。'
    case 'ask_reason':
      return '请用户简单说明挂失原因。任何合理的回答都可以进入确认步骤。'
    case 'confirm':
      return '向用户确认已收集的信息。等待用户说确认、修改还是取消。'
    case 'done':
      return '告知用户挂失已受理，给出受理单号。如果用户还想办其他业务可以继续。'
    case 'unsupported':
      return '告知用户当前仅支持银行卡挂失，已转接人工服务。'
    default:
      return '引导用户继续挂失流程。'
  }
}

/** 解析 LLM 返回的 JSON 字符串 */
export function parseLLMResponse(raw: string): {
  reply: string
  intent: string
  extractedData: Partial<SessionData>
} | null {
  try {
    // 从返回中提取第一个完整 JSON 对象
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end === -1 || start >= end) return null
    const parsed = JSON.parse(raw.slice(start, end + 1))
    return {
      reply: parsed.reply ?? '',
      intent: parsed.intent ?? 'stay',
      extractedData: {
        businessType: parsed.extractedData?.businessType ?? undefined,
        cardNo: parsed.extractedData?.cardNo ?? undefined,
        idNo: parsed.extractedData?.idNo ?? undefined,
        reason: parsed.extractedData?.reason ?? undefined,
      },
    }
  } catch {
    return null
  }
}
