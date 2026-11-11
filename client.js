/**
 * dsh-hot-restart-row —— 客户端那一半（只干一件事：在**账号菜单**里、“退出登录”下面
 * 添一行“热重启”）。
 *
 * 为什么是 DOM 注入而不是插槽：那个菜单是 shell 自带 UI —— `Slots.listSubTree`
 * 全量核对过，整棵树里没有任何 account/menu 座位（侧边栏底部只有
 * `sidebar.footer.action`，那是“设置”旁边的动作位，不是这个弹出菜单）。所以这里
 * 克隆“退出登录”那一行、换掉文案与图标、插在它后面：克隆能让新行自动继承 shell
 * 自己的行样式（图标槽、内边距、hover、深浅色），菜单换皮时它跟着变。
 *
 * 菜单是按需挂载/卸载的，所以用一个 MutationObserver 盯着 body：每次菜单出现就把
 * 这一行补回去（已经在了就跳过）。
 *
 * 点一下发生什么：
 *   POST /dsh-hot-restart/restart  宿主回 200 之后在后台重载 profile 插件树
 *   → 行文案切到“正在刷新” → `location.reload()` 让页面重新拉 index.html 与
 *   client bundle。对话存在 durable session log 里，刷新只是重新渲染。
 */
window.__ModuleLoader__.load({
  id: 'dsh-hot-restart-row',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var RESTART_URL = '/dsh-hot-restart/restart'
    /** 诊断路由：宿主在这里回 `lastRun`，客户端据此判断对账是否真的结束。 */
    var STATUS_URL = '/dsh-hot-restart/status'
    /** 回执路由：宿主把它追加进包目录下的 report.json（没有浏览器时的排查手段）。 */
    var REPORT_URL = '/dsh-hot-restart/report'
    /** 注入行的标记属性（同时用来避免重复注入）。 */
    var MENU_MARK = 'data-dsh-hot-restart-row'
    /** 账号菜单里“退出登录”的几种写法，用来定位菜单本体。 */
    var LOGOUT_LABELS = ['退出登录', '登出', 'Sign out', 'Sign Out', 'Log out', 'Logout']
    /** 一圈开口的箭头（“重新开始”），跟着 currentColor 走。 */
    var ICON_PATHS =
      '<path d="M20.4 12a8.4 8.4 0 1 1-2.9-6.31"></path><path d="M20.4 4.3v5.1h-5.1"></path>'

    /** 排查标记：模块体真的执行过（页面里应为 'v0.2.4'）。 */
    window.__DSH_HOT_RESTART_CLIENT__ = 'v0.2.4'

    /**
     * 当前界面语言。
     * @param {any} ctx 插件上下文（可能带 `locale`）。
     * @returns {string} 小写语言标签。
     */
    function currentLanguage(ctx) {
      try {
        if (ctx !== undefined && ctx !== null && ctx.locale && typeof ctx.locale.getLocale === 'function') {
          return String(ctx.locale.getLocale() || '').toLowerCase()
        }
      } catch {
        // 读不到就退回浏览器语言。
      }
      try {
        return String(navigator.language || '').toLowerCase()
      } catch {
        return ''
      }
    }

    /**
     * 取当前语言的一侧文案。
     * @param {any} ctx 插件上下文。
     * @param {string} zh 中文。
     * @param {string} en 英文。
     * @returns {string} 选中的文案。
     */
    function pick(ctx, zh, en) {
      return currentLanguage(ctx).indexOf('zh') === 0 ? zh : en
    }

    /**
     * 把一批回执发给宿主（失败就算了，回执不该影响按钮）。
     * @param {Record<string, unknown>} payload 回执内容。
     * @returns {void}
     */
    function report(payload) {
      try {
        fetch(REPORT_URL, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(function () {})
      } catch {
        // 忽略：回执是排查用的，不是功能。
      }
    }

    /**
     * 一行里所有文本节点。
     * @param {Node} root 根。
     * @returns {Text[]} 文本节点。
     */
    function textNodesOf(root) {
      /** @type {Text[]} */
      var out = []
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
      var node = walker.nextNode()
      while (node !== null) {
        out.push(node)
        node = walker.nextNode()
      }
      return out
    }

    /**
     * 把一行里第一段可见文字换成新文案（保留图标与内边距）。
     * @param {Element} row 菜单行。
     * @param {string} text 新文案。
     * @returns {boolean} 是否换到了。
     */
    function replaceRowText(row, text) {
      var nodes = textNodesOf(row)
      for (var i = 0; i < nodes.length; i++) {
        if ((nodes[i].nodeValue || '').trim() === '') continue
        nodes[i].nodeValue = text
        return true
      }
      return false
    }

    /**
     * 在页面里找“退出登录”那一行（只在菜单打开时存在）。
     * 用 XPath 按“直接文本节点等于文案”定位 —— 比遍历 `body *` 便宜得多，
     * 聊天区每帧都在变动时也不会把主线程拖住。
     * @returns {Element | null} 菜单行。
     */
    function findLogoutRow() {
      for (var i = 0; i < LOGOUT_LABELS.length; i++) {
        var label = LOGOUT_LABELS[i].replace(/"/g, '')
        try {
          var snapshot = document.evaluate(
            '//*[normalize-space(text())="' + label + '"]',
            document,
            null,
            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
            null,
          )
          for (var j = 0; j < snapshot.snapshotLength; j++) {
            var textNodeHost = snapshot.snapshotItem(j)
            if (textNodeHost === null || textNodeHost.hasAttribute(MENU_MARK)) continue
            // 行本身可能是 button/a/li，也可能只是 div；取最近的可点击祖先。
            var row = textNodeHost.closest('button,[role="menuitem"],[role="button"],a,li')
            return row !== null ? row : textNodeHost
          }
        } catch {
          // XPath 不可用（极端环境）时退回下面的遍历。
        }
      }
      var clickable = document.querySelectorAll('button,[role="menuitem"],a,li,[role="button"]')
      for (var k = 0; k < clickable.length; k++) {
        var el = clickable[k]
        if (el.hasAttribute(MENU_MARK)) continue
        if (LOGOUT_LABELS.indexOf((el.textContent || '').trim()) !== -1) return el
      }
      return null
    }

    /**
     * 把“退出登录”那一行克隆重造成“热重启”，插在它下面。
     * @param {any} ctx 插件上下文。
     * @returns {boolean} 这一轮是否注入了。
     */
    function injectMenuRow(ctx) {
      if (document.querySelector('[' + MENU_MARK + ']') !== null) return false
      // 菜单没打开时先便宜地退出来：聊天流式渲染会不停触发 observer，
      // 每次都跑一遍全文档 XPath 是没必要的开销。
      if (document.querySelector('[role="menuitem"]') === null) return false
      var row = findLogoutRow()
      if (row === null || row.parentNode === null) return false

      var clone = /** @type {HTMLElement} */ (row.cloneNode(true))
      clone.setAttribute(MENU_MARK, 'v0.2.4')
      clone.removeAttribute('aria-haspopup')
      clone.removeAttribute('aria-expanded')
      clone.removeAttribute('aria-controls')
      clone.setAttribute('data-phase', 'idle')
      replaceRowText(clone, pick(ctx, '热重启', 'Hot restart'))
      clone.setAttribute('title', pick(ctx, '重载插件并刷新界面', 'Reload plugins and refresh the page'))

      var svg = clone.querySelector('svg')
      if (svg !== null) {
        svg.setAttribute('viewBox', '0 0 24 24')
        svg.setAttribute('fill', 'none')
        svg.setAttribute('stroke', 'currentColor')
        svg.setAttribute('stroke-width', '1.9')
        svg.setAttribute('stroke-linecap', 'round')
        svg.setAttribute('stroke-linejoin', 'round')
        svg.innerHTML = ICON_PATHS
      }

      clone.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        runFromMenu(clone, ctx)
      })

      row.parentNode.insertBefore(clone, row.nextSibling)
      report({ kind: 'menu-injected', at: Date.now(), row: clone.outerHTML.slice(0, 1200) })
      return true
    }

    /**
     * 等宿主把这次对账真正跑完，再让页面刷新。
     *
     * 不能只等固定延时：对账会换掉 clientModules 的 bundle 版本，如果页面在版本
     * 切换的中途重新加载，会拿到旧 rev 的分包 URL 而 404，启动阶段就会报
     * "entries did not activate"（市场刚装完插件时对账可能排很久，尤其明显）。
     * 所以轮询 `/status`，直到 `lastRun.finishedAt` 落定为止。
     *
     * @param {number|undefined} ticket 本次重启的票号（宿主在 POST 响应里给）。
     * @param {number} deadline 最晚等到什么时候（毫秒时间戳）。
     * @returns {Promise<any>} 对账结果；超时或一直读不到就返回 null。
     */
    function waitForSettle(ticket, deadline) {
      function poll() {
        if (Date.now() > deadline) return Promise.resolve(null)
        return fetch(STATUS_URL, { cache: 'no-store' })
          .then(function (res) {
            return res.ok ? res.json() : null
          })
          .catch(function () {
            return null
          })
          .then(function (payload) {
            var run = payload !== null && typeof payload === 'object' ? payload.lastRun : null
            if (run !== null && typeof run === 'object' && run.finishedAt > 0) {
              // 票号对不上说明是别人触发的那一次，继续等自己的。
              if (ticket === undefined || ticket === null || run.ticket === ticket) return run
            }
            return new Promise(function (resolve) {
              window.setTimeout(resolve, 250)
            }).then(poll)
          })
      }
      return poll()
    }

    /**
     * 菜单行的点击处理：请求宿主对账，等对账结束再刷新页面。
     * 没有 React 状态可借，直接用 `data-phase` + 文案表达进度。
     * @param {HTMLElement} row 注入的那一行。
     * @param {any} ctx 插件上下文。
     * @returns {void}
     */
    function runFromMenu(row, ctx) {
      if (row.getAttribute('data-phase') === 'busy') return
      row.setAttribute('data-phase', 'busy')
      replaceRowText(row, pick(ctx, '正在重启…', 'Restarting…'))

      fetch(RESTART_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'account-menu' }),
      })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status)
          return res.json().catch(function () {
            return null
          })
        })
        .then(function (payload) {
          if (payload !== null && typeof payload === 'object' && payload.error) {
            throw new Error(String(payload.error))
          }
          var ticket = payload !== null && typeof payload === 'object' ? payload.ticket : undefined
          replaceRowText(row, pick(ctx, '正在重载插件…', 'Reloading plugins…'))
          return waitForSettle(ticket, Date.now() + 60000)
        })
        .then(function (run) {
          if (run !== null && run.ok === false) {
            throw new Error('reconcile failed: ' + String(run.detail))
          }
          replaceRowText(row, pick(ctx, '正在刷新…', 'Reloading…'))
          // 对账已结束，再给 clientModules 一点时间把新 bundle 注册完。
          window.setTimeout(function () {
            window.location.reload()
          }, 320)
        })
        .catch(function (failure) {
          var message = (failure && failure.message) || String(failure)
          row.setAttribute('data-phase', 'failed')
          row.setAttribute('title', message)
          replaceRowText(row, pick(ctx, '重启失败，重试', 'Retry restart'))
          window.setTimeout(function () {
            if (row.isConnected === false) return
            row.setAttribute('data-phase', 'idle')
            replaceRowText(row, pick(ctx, '热重启', 'Hot restart'))
          }, 3000)
        })
    }

    /**
     * 盯着 DOM：账号菜单按需挂载/卸载，每次出现都把那一行补回去。
     * @param {any} ctx 插件上下文。
     * @returns {void}
     */
    function watchAccountMenu(ctx) {
      try {
        injectMenuRow(ctx)
        var scheduled = false
        var observer = new MutationObserver(function () {
          if (scheduled) return
          scheduled = true
          window.setTimeout(function () {
            scheduled = false
            try {
              injectMenuRow(ctx)
            } catch (error) {
              report({ kind: 'menu-error', at: Date.now(), error: String((error && error.message) || error) })
            }
          }, 60)
        })
        observer.observe(document.body, { childList: true, subtree: true })
      } catch (error) {
        report({ kind: 'menu-watch-failed', at: Date.now(), error: String((error && error.message) || error) })
      }
    }

    /**
     * 插件入口：只需要 DOM，不占任何插槽。
     * @param {any} ctx 插件上下文。
     * @returns {void}
     */
    function apply(ctx) {
      watchAccountMenu(ctx)
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
