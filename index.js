/**
 * dsh-hot-restart-row —— 宿主那一半。
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
export const VERSION = '0.2.8'

/** 注入到 index.html 的自愈脚本的标记，用来判断是否已经注过。 */
export const BOOT_GUARD_MARK = 'data-dsh-hot-restart-boot-guard'

/** 注入到 index.html 的菜单脚本的标记（脚本本身在 runtime/menu.js）。 */
export const MENU_SCRIPT_MARK = 'data-dsh-hot-restart-menu'

/**
 * 菜单脚本的源码：启动时读一次，之后每次渲染首页都用同一份。
 *
 * 读不到也不能让插件挂掉 —— 那只是少一行按钮。
 * @returns {string}
 */
function readMenuScript() {
  try {
    return fs.readFileSync(new URL('./runtime/menu.js', import.meta.url), 'utf8')
  } catch {
    return ''
  }
}

/** 页面那一半的源码。 */
const MENU_SCRIPT = readMenuScript()

/** 宿主进程启动后被本模块加载的时刻（≈ DSH 启动时间）。 */
const loadedAt = Date.now()

/** 最近若干次重启的记录（新的在前）。 */
const history = []
/** 单次记录里最多记几条，够看就行，不做持久化。 */
const HISTORY_LIMIT = 10

/**
 * 最近一次重启的进度，供客户端**等对账真的结束**再刷新页面。
 *
 * 为什么要这个：`POST /restart` 必须先把响应写出去（对账会重建本插件所在的
 * fiber，先 await 再回响应的话浏览器只会拿到断连接）。但页面如果在对账跑完
 * 之前就 `location.reload()`，重新拉 index.html 的那一瞬间 clientModules 的
 * bundle 版本可能刚好被对账替换 —— 页面拿到的是旧 rev 的分包 URL，404 之后
 * 整条 bundle 被跳过，启动阶段就会报 "N entries did not activate"。
 * 所以客户端拿 ticket 轮询 `/status`，等 `finishedAt` 落定再刷新。
 *
 * 状态挂在 `globalThis` 上而不是模块作用域里：对账有可能把本模块重新 import
 * 一次（那样模块级 `let` 会归零，客户端就永远等不到自己的 ticket，只能干等满
 * 超时）。挂全局以后，重新 import 出来的新模块实例读到的还是同一份进度。
 *
 * @typedef {{ ticket: number, startedAt: number, finishedAt: number, ok: boolean | null, detail: unknown }} RestartRun
 */
const STATE_KEY = '__DSH_HOT_RESTART_STATE__'

/**
 * 取（必要时创建）进程级的重启状态。
 * @returns {{ ticketSeq: number, lastRun: RestartRun | null }} 状态对象。
 */
function state() {
  if (globalThis[STATE_KEY] === undefined) {
    globalThis[STATE_KEY] = { ticketSeq: 0, lastRun: null }
  }
  return globalThis[STATE_KEY]
}

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
 * @param {number} ticket 票号（与客户端轮询对得上）。
 */
function record(ok, tookMs, detail, ticket) {
  history.unshift({ at: Date.now(), ok, tookMs, detail, ticket })
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT
}

/**
 * 等 clientModules 的 graph 稳定下来。
 *
 * 对账会重启一批 fiber，clientModules 每收到一个内部 plugin 事件就重算一次图；
 * 图在抖动的这段窗口里，index.html 里写的 rev 和真正被请求的 bundle 可能对不上，
 * 页面就会在启动阶段找不到某个条目。所以刷新页面前必须等它安静下来。
 * @param {any} clientModules clientModules 服务。
 * @param {number} quietMs 连续多久不变化算稳定。
 * @param {number} timeoutMs 最长等多久。
 * @returns {Promise<{ rev: string, stable: boolean, waitedMs: number }>} 稳定结果。
 */
async function settleGraph(clientModules, quietMs, timeoutMs) {
  const beganAt = Date.now()
  const deadline = beganAt + timeoutMs
  let rev = String(clientModules.graph().rev ?? '')
  let since = Date.now()
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    let current = rev
    try {
      current = String(clientModules.graph().rev ?? '')
    } catch {
      // 读不到就当没变化。
    }
    if (current !== rev) {
      rev = current
      since = Date.now()
      continue
    }
    if (Date.now() - since >= quietMs) return { rev, stable: true, waitedMs: Date.now() - beganAt }
  }
  return { rev, stable: false, waitedMs: Date.now() - beganAt }
}

/**
 * 把页面接下来一定会请求的 bundle 先烘出来（每个 bundle 首次 GET 时才会构建）。
 * 全部成功才允许刷新页面：宁可报错不刷新，也不要让页面带着 404 启动失败。
 * @param {any} clientModules clientModules 服务。
 * @returns {Promise<{ total: number, ok: number, failed: Array<Record<string, unknown>> }>} 结果。
 */
async function warmBundles(clientModules) {
  /** @type {Array<any>} */
  let rows = []
  try {
    rows = Array.isArray(clientModules.graph().entries) ? clientModules.graph().entries : []
  } catch {
    rows = []
  }
  const failed = []
  let ok = 0
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || typeof row.url !== 'string') continue
    try {
      const response = await clientModules.fetchBundle({
        method: 'GET',
        url: row.url,
        headers: new Headers(),
      })
      const text = await response.text()
      if (response.status === 200 && text.length > 0) ok += 1
      else failed.push({ id: row.id, status: response.status })
    } catch (error) {
      failed.push({ id: row.id, error: describe(error) })
    }
  }
  return { total: rows.length, ok, failed }
}

/**
 * 在后台把 profile 的 patch 重新对账进运行中的 Loader 树。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文（已含 webServer 的子上下文）。
 * @param {number} ticket 本次重启的票号。
 * @returns {Promise<void>} 对账结束后 resolve（失败也 resolve，错误记进 history）。
 */
async function reconcileInBackground(ctx, ticket) {
  const beganAt = Date.now()
  /** @type {unknown} */
  let hmr
  try {
    hmr = ctx.get('hmr')
  } catch (error) {
    finish(ticket, false, Date.now() - beganAt, describe(error))
    return
  }
  if (hmr === undefined || hmr === null) {
    finish(ticket, false, Date.now() - beganAt, 'hmr service is unavailable in this profile')
    return
  }

  try {
    // `reconcileProfile()` 要求独占：多个插件同时触发对账会把 Loader 树撕成两半。
    // 它自己不会加锁，会直接抛 "must run inside runExclusive"，所以这里必须套一层。
    const result = await hmr.runExclusive(async () => await hmr.reconcileProfile())

    /** @type {any} */
    let clientModules
    try {
      clientModules = ctx.get('clientModules')
    } catch {
      clientModules = undefined
    }

    if (clientModules === undefined || clientModules === null) {
      finish(ticket, true, Date.now() - beganAt, summarizeReconciliation(result))
      return
    }

    // 关键：对账会重启一批 fiber，clientModules 的图会抖动一阵；页面必须等它安静，
    // 并且先把 bundle 烘好，否则刷新后会带着 404 启动失败（web boot: entry did not activate）。
    const settled = await settleGraph(clientModules, 800, 20000)
    const warm = await warmBundles(clientModules)

    /** @type {Record<string, unknown>} */
    const detail = {
      reconciliation: summarizeReconciliation(result),
      graph: settled,
      warm: { total: warm.total, ok: warm.ok, failed: warm.failed.slice(0, 8) },
    }

    if (warm.failed.length > 0 || settled.stable === false) {
      finish(ticket, false, Date.now() - beganAt, detail)
      return
    }
    finish(ticket, true, Date.now() - beganAt, detail)
  } catch (error) {
    finish(ticket, false, Date.now() - beganAt, describe(error))
  }
}

/**
 * 收尾一次重启：同时写到历史和 `lastRun`（客户端据此决定何时刷新）。
 * @param {number} ticket 票号。
 * @param {boolean} ok 是否成功。
 * @param {number} tookMs 耗时。
 * @param {unknown} detail 结果或错误。
 * @returns {void}
 */
function finish(ticket, ok, tookMs, detail) {
  record(ok, tookMs, detail, ticket)
  const current = state().lastRun
  if (current !== null && current.ticket === ticket) {
    current.ok = ok
    current.detail = detail
    current.finishedAt = Date.now()
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
    name: 'dsh-hot-restart-row',
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

  // 客户端轮询用：`lastRun.finishedAt > 0` 才代表对账真的结束、bundle 版本已经稳定。
  const current = state().lastRun
  payload.lastRun = current === null ? null : { ...current }

  // 自愈脚本是否已经在首页里露过面（宿主要渲染过一次 index.html 才为 true）。
  payload.bootGuard = { injected: didReportGuard }

  // 非空说明这次装配抛过错（插件仍然被加载，只是可能缺路由）。
  payload.activationError = activationError

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

/** 装配期抛出的错误（有的话由 /status 暴露，页面仍能启动）。 */
let activationError = null

/**
 * 记录装配失败：既写报告，也留给 /status。
 * @param {unknown} error 抛出来的东西。
 * @returns {void}
 */
function reportActivationError(error) {
  activationError = describe(error)
  try {
    appendReport({
      receivedAt: new Date().toISOString(),
      payload: {
        kind: 'host-activate-failed',
        version: VERSION,
        error: activationError,
        stack: String(error && error.stack ? error.stack : '').slice(0, 4000),
      },
    })
  } catch {
    // 报告写不进去也只能算了。
  }
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
 * 自愈脚本：盯住 `/plugins/…&rev=…` 的分包脚本加载失败。
 *
 * 为什么需要它：clientModules 的图每次对被对账都会换 rev，而它只保留「当前」
 * 与「上一代」两批响应。页面如果在图连续换代几次的空隙里开始加载（典型场景：
 * 市场刚装完插件就自己 `location.reload()`，后台还在跑自己的对账），拿到的是
 * 已经不在响应表里的旧 rev URL —— 404 之后 loader 会把整个 bundle 标记为
 * `skipped after an earlier failure of this bundle`，启动阶段就报
 * “N entries did not activate”，DSH 直接弹「应用无法启动」。
 *
 * 这个脚本在 head 里最先执行（经典脚本，早于 deferred 的入口模块），用捕获阶段
 * 的 error 监听接住分包脚本的加载失败，然后**带着当前 rev 重新载入一次页面**。
 * 用 sessionStorage 计数限流：60 秒内最多 2 次，之后交回给 DSH 自己的报错，
 * 避免真坏掉时无限刷新。
 */
const BOOT_GUARD_SCRIPT = `(function () {
  if (window.__DSH_HR_BOOT_GUARD__) return
  window.__DSH_HR_BOOT_GUARD__ = true
  var KEY = 'dsh-hot-restart:boot-retry'
  var LIMIT = 2
  var WINDOW_MS = 60000
  var failed = false
  function read() {
    try {
      var raw = sessionStorage.getItem(KEY)
      if (!raw) return { count: 0, at: 0 }
      var value = JSON.parse(raw)
      return { count: Number(value && value.count) || 0, at: Number(value && value.at) || 0 }
    } catch (error) {
      return { count: 0, at: 0 }
    }
  }
  function write(value) {
    try { sessionStorage.setItem(KEY, JSON.stringify(value)) } catch (error) {}
  }
  function report(src) {
    try {
      fetch('/dsh-hot-restart/report', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'boot-guard', at: new Date().toISOString(), src: String(src).slice(0, 500), href: location.href })
      }).catch(function () {})
    } catch (error) {}
  }
  window.addEventListener('error', function (event) {
    var el = event && event.target
    if (!el || el === window || el === document || el.tagName !== 'SCRIPT') return
    var src = ''
    try { src = String(el.getAttribute('src') || el.src || '') } catch (error) { return }
    if (src.indexOf('/plugins/') === -1) return
    failed = true
    report(src)
    retry(false)
  }, true)
  // 分包没报错、但启动仍然失败时（比如 manifest 与图换代错位），页面会停在
  // 「应用无法启动」的提示上。这种时候也要自愈：带一次 cache-buster 重载。
  function looksFatal() {
    try {
      var text = String((document.body && document.body.innerText) || '')
      if (text.length === 0) return false
      return text.indexOf('did not activate') !== -1 || text.indexOf('无法使用') !== -1 || text.indexOf('无法启动') !== -1
    } catch (error) {
      return false
    }
  }
  function retry(bust) {
    var now = Date.now()
    var state = read()
    if (state.count > 0 && now - state.at > WINDOW_MS) state = { count: 0, at: 0 }
    if (state.count >= LIMIT) return false
    var next = { count: state.count + 1, at: now }
    write(next)
    setTimeout(function () {
      if (!bust) {
        location.reload()
        return
      }
      try {
        var url = new URL(location.href)
        url.searchParams.set('hr-bust', String(now))
        location.replace(url.toString())
      } catch (error) {
        location.reload()
      }
    }, 600 + next.count * 400)
    return true
  }
  window.addEventListener('load', function () {
    if (failed) return
    setTimeout(function () {
      if (looksFatal() && retry(true)) return
      write({ count: 0, at: 0 })
    }, 1500)
  })
})()`

let didReportGuard = false

/**
 * 把自愈脚本插进 index.html 的 `</head>` 之前（已插过就原样返回）。
 * @param {string} html 渲染好的首页。
 * @returns {string} 注入后的首页。
 */
export function injectBootGuard(html) {
  if (typeof html !== 'string' || html.length === 0) return html
  if (html.includes(BOOT_GUARD_MARK)) return html
  const tag = `<script ${BOOT_GUARD_MARK}="1">${BOOT_GUARD_SCRIPT}</script>`
  // 优先紧跟 <head>：经典脚本在解析时立刻执行，比 deferred 的入口模块更早装好监听。
  const head = /<head\b[^>]*>/i.exec(html)
  let next
  if (head !== null) {
    const at = head.index + head[0].length
    next = `${html.slice(0, at)}${tag}${html.slice(at)}`
  } else {
    const end = html.search(/<\/head>/i)
    next = end === -1 ? `${tag}${html}` : `${html.slice(0, end)}${tag}${html.slice(end)}`
  }
  if (!didReportGuard) {
    didReportGuard = true
    try {
      appendReport({ receivedAt: new Date().toISOString(), payload: { kind: 'boot-guard-injected', version: VERSION } })
    } catch {
      // 落盘失败不影响页面。
    }
  }
  return next
}

/**
 * 把菜单脚本插进 index.html 的 `</body>` 之前（已插过就原样返回）。
 *
 * 为什么走 tapIndex 而不是 `dsh.client`：client 入口是启动关键路径，任何一个
 * 条目没激活，DSH 就整窗报「应用无法启动」。这一半只负责一行菜单，不该有那个
 * 权力。行内经典脚本必然执行，出错也只是少一行按钮。
 * @param {string} html 渲染好的首页。
 * @returns {string} 注入后的首页。
 */
export function injectMenuScript(html) {
  if (typeof html !== 'string' || html.length === 0) return html
  if (html.includes(MENU_SCRIPT_MARK)) return html
  if (MENU_SCRIPT.length === 0) return html
  const tag = `<script ${MENU_SCRIPT_MARK}="1">\n${MENU_SCRIPT}\n</script>`
  const end = html.search(/<\/body>/i)
  return end === -1 ? `${html}${tag}` : `${html.slice(0, end)}${tag}${html.slice(end)}`
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  try {
    ctx.inject(['webServer'], (child) => {
      child.effect(() => {
        try {
          return activate(child)
        } catch (error) {
          reportActivationError(error)
          return () => {}
        }
      })
    })
  } catch (error) {
    reportActivationError(error)
  }
}

/**
 * 真正的装配：注册路由、注入首页自愈脚本。
 * 任何一步抛错都只上报、不向上冒泡 —— 装配失败的插件会让 DSH 在启动阶段报
 * “entries did not activate”，整窗弹「应用无法启动」，代价远大于少一个按钮。
 * @param {any} child 带 webServer 的子上下文。
 * @returns {() => void} 清理函数。
 */
function activate(child) {
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
            const ticket = ++state().ticketSeq
            state().lastRun = { ticket, startedAt: at, finishedAt: 0, ok: null, detail: null }
            try {
              reply(res, 200, {
                ok: true,
                accepted: true,
                at,
                ticket,
                version: VERSION,
                note: 'profile plugins will be reconciled in the background; poll /status until lastRun.finishedAt is set before reloading',
              })
            } catch (error) {
              // 响应都写不出去，就没有后续了。
              finish(ticket, false, Date.now() - at, describe(error))
              return
            }

            // 放到下一个宏任务：先让响应写出去，再动 Loader 树。
            setTimeout(() => {
              void reconcileInBackground(child, ticket)
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

      // ── 自愈：把 head 脚本注入首页，分包 404 时带新 rev 自动重载一次 ──
      disposers.push(child.webServer.tapIndex(injectBootGuard))

      // ── 菜单：把页面上那一半边直接注入首页（不走 client 模块加载器） ──
      disposers.push(child.webServer.tapIndex(injectMenuScript))

  return () => {
    for (const dispose of disposers) dispose()
  }
}
