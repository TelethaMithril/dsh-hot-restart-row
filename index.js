/**
 * dsh-hot-restart —— 宿主那一半。
 *
 * 作用：给界面上的"热重启"按钮提供一个真正的落点。DSH 没有"重启进程"的 API
 * （`agents` / `sessions` / `agentPresets` 都没有），但"热重启"能做的事情有两件，
 * 也正是改完插件后真正需要的两件：
 *
 *   ① 让 **profile 的插件树**按磁盘上的 patch 重新对账 —— `hmr.reconcileProfile()`。
 *      增删插件行、改插件配置之后，不用关窗口就能生效。
 *   ② 让**客户端**重新拉取 index.html 与 client bundle —— 浏览器端 `location.reload()`，
 *      由按钮那一半负责。
 *
 * 对话本身存在 durable session log 里，刷新页面不会丢；agent 进程也不受影响。
 * 换句话说：这是"换掉运行时，保留上下文"，不是"杀进程重开"。
 *
 * 路由（同源，无需鉴权 —— 和 DSH 自带的 Web 路由同一个信任边界）：
 *   GET  /dsh-hot-restart/status   诊断信息（pid / 运行时长 / 活 agent / profile 路径 / 重启历史）
 *   POST /dsh-hot-restart/restart  触发一次热重启（GET 也接受，便于用浏览器地址栏排查）
 *   POST /dsh-hot-restart/report   客户端回执（把页面上注入到的 DOM 落到 report.json，便于无浏览器时核对）
 *
 * 设计取舍：先回响应、再在后台重载。对账会把本插件所在的 fiber 重新评估一遍，
 * 如果先 await 再回响应，一旦对账过程中本行被重建，浏览器拿到的就是一个断掉的
 * 连接 —— 按钮会显示"失败"，可其实已经重启成功。先回 200 就没有这个歧义。
 */
import fs from 'node:fs'
import process from 'node:process'

/** Cordis 诊断用的插件名。 */
export const name = 'hot-restart'

/** 没有必需服务：`webServer` 用 `ctx.inject` 迟到接入，不阻塞 apply。 */
export const inject = []

/** 所有路由共享的前缀。 */
export const ROUTE_PREFIX = '/dsh-hot-restart'
/** 诊断信息。 */
export const STATUS_ROUTE = `${ROUTE_PREFIX}/status`
/** 触发热重启。 */
export const RESTART_ROUTE = `${ROUTE_PREFIX}/restart`
/** 客户端自检回执（把它在页面上看到了什么写到 report.json，方便无浏览器时排查）。 */
export const REPORT_ROUTE = `${ROUTE_PREFIX}/report`

/** 与 package.json 的 version 保持一致。 */
export const VERSION = '0.2.0'

/** 宿主进程启动后被本模块加载的时刻（≈ DSH 启动时间）。 */
const loadedAt = Date.now()

/** 最近若干次重启的记录（新的在前）。 */
const history = []
/** 单次记录里最多记几条，够看就行，不做持久化。 */
const HISTORY_LIMIT = 10

/**
 * 把任意抛出物变成一句人话。
 * @param {unknown} error 抛出物。
 * @returns {string} 描述。
 */
function describe(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * 把对账结果压成 JSON 可打印的形状：`reconcileProfile()` 的返回值是实现细节，
 * 界面上只需要"动了哪些行 / 有没有 warnings"。
 * @param {unknown} result `reconcileProfile()` 的返回值。
 * @returns {unknown} 可序列化的摘要。
 */
function summarizeReconciliation(result) {
  if (result === null || typeof result !== 'object') return result ?? null
  try {
    const text = JSON.stringify(result)
    // 超过 8KB 的结果对排查没帮助，截断成一句提示。
    if (typeof text === 'string' && text.length > 8192) {
      return { truncated: true, bytes: text.length }
    }
    return JSON.parse(text)
  } catch (error) {
    return { unreadable: describe(error) }
  }
}

/**
 * 记录一次重启。
 * @param {boolean} ok 是否成功。
 * @param {number} tookMs 耗时。
 * @param {unknown} detail 结果或错误。
 */
function record(ok, tookMs, detail) {
  history.unshift({ at: Date.now(), ok, tookMs, detail })
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT
}

/**
 * 在后台把 profile 的 patch 重新对账进运行中的 Loader 树。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文（已含 webServer 的子上下文）。
 * @returns {Promise<void>} 对账结束后 resolve（失败也 resolve，错误记进 history）。
 */
async function reconcileInBackground(ctx) {
  const beganAt = Date.now()
  /** @type {unknown} */
  let hmr
  try {
    hmr = ctx.get('hmr')
  } catch (error) {
    record(false, Date.now() - beganAt, describe(error))
    return
  }
  if (hmr === undefined || hmr === null) {
    record(false, Date.now() - beganAt, 'hmr service is unavailable in this profile')
    return
  }

  try {
    // `reconcileProfile()` 要求独占：多个插件同时触发对账会把 Loader 树撕成两半。
    // 它自己不会加锁，会直接抛 "must run inside runExclusive"，所以这里必须套一层。
    const result = await hmr.runExclusive(async () => await hmr.reconcileProfile())
    record(true, Date.now() - beganAt, summarizeReconciliation(result))
  } catch (error) {
    record(false, Date.now() - beganAt, describe(error))
  }
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应。
 * @param {number} status HTTP 状态码。
 * @param {unknown} body 响应体。
 */
function reply(res, status, body) {
  const text = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

/**
 * 采集诊断信息。失败一律降级成字段里的字符串，绝不让诊断本身抛错。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @returns {Record<string, unknown>} 诊断负载。
 */
function statusPayload(ctx) {
  /** @type {Record<string, unknown>} */
  const payload = {
    name: 'dsh-hot-restart',
    version: VERSION,
    ok: true,
  }

  payload.process = {
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
    loadedAt,
    now: Date.now(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    electron: process.versions?.electron ?? null,
  }

  try {
    const hmr = ctx.get('hmr')
    payload.profile = hmr?.baseDir ?? null
    payload.hmr = { available: hmr !== undefined && hmr !== null }
  } catch (error) {
    payload.hmr = { available: false, error: describe(error) }
  }

  try {
    const agents = ctx.get('agents')
    const list = agents?.list?.() ?? []
    payload.agents = list.map((agent) => ({ id: String(agent.id) }))
    payload.roots = (agents?.roots?.() ?? []).map((agent) => ({ id: String(agent.id) }))
  } catch (error) {
    payload.agents = { error: describe(error) }
  }

  payload.restarts = {
    count: history.length,
    recent: history.slice(0, HISTORY_LIMIT),
  }

  return payload
}

/** 客户端回执落盘的路径（就是包目录下的 report.json）。 */
const REPORT_FILE = new URL('./report.json', import.meta.url)

/**
 * 把客户端的一批回执追加进 report.json。
 * @param {unknown} entry 回执。
 * @returns {void}
 */
function appendReport(entry) {
  /** @type {unknown[]} */
  let list = []
  try {
    const parsed = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'))
    if (Array.isArray(parsed)) list = parsed
  } catch {
    // 文件不存在 / 不是 JSON：从头开始。
  }
  list.push(entry)
  // 只留最近 40 条：这是排查用的,不是日志系统。
  if (list.length > 40) list.splice(0, list.length - 40)
  fs.writeFileSync(REPORT_FILE, JSON.stringify(list, null, 2), 'utf8')
}

/**
 * 读完整个请求体。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @param {number} limit 字节上限。
 * @returns {Promise<string>} 文本。
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`payload exceeds ${limit} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (child) => {
    child.effect(() => {
      /** @type {Array<() => void>} */
      const disposers = []

      // ── 诊断：浏览器地址栏直接敲也能看 ──
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: STATUS_ROUTE,
          handler: (req, res) => {
            try {
              reply(res, 200, statusPayload(child))
            } catch (error) {
              reply(res, 500, { ok: false, error: describe(error) })
            }
          },
        }),
      )

      // ── 热重启：先回响应，再在后台对账 ──
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: RESTART_ROUTE,
          handler: (req, res) => {
            const method = String(req.method ?? 'GET').toUpperCase()
            if (method !== 'GET' && method !== 'POST') {
              reply(res, 405, { ok: false, error: `method ${method} is not supported` })
              return
            }

            const at = Date.now()
            try {
              reply(res, 200, {
                ok: true,
                accepted: true,
                at,
                version: VERSION,
                note: 'profile plugins will be reconciled in the background; the page reloads on the client side',
              })
            } catch (error) {
              // 响应都写不出去，就没有后续了。
              record(false, Date.now() - at, describe(error))
              return
            }

            // 放到下一个宏任务：先让响应写出去，再动 Loader 树。
            setTimeout(() => {
              void reconcileInBackground(child)
            }, 25)
          },
        }),
      )

      // ── 客户端回执：把页面上看到的 DOM 落盘，便于没有浏览器的环境下核对 ──
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: REPORT_ROUTE,
          handler: async (req, res) => {
            if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
              reply(res, 405, { ok: false, error: 'POST only' })
              return
            }
            try {
              const text = await readBody(req, 256 * 1024)
              const parsed = JSON.parse(text)
              appendReport({ receivedAt: new Date().toISOString(), payload: parsed })
              reply(res, 200, { ok: true })
            } catch (error) {
              reply(res, 400, { ok: false, error: describe(error) })
            }
          },
        }),
      )

      return () => {
        for (const dispose of disposers) dispose()
      }
    })
  })
}
