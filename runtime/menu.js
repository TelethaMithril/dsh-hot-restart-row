/**
 * dsh-hot-restart-row —— 页面那一半，**不走 client 模块加载器**。
 *
 * 为什么不再做成 `dsh.client`：启动阶段那套入口（`entries.start`）只要有一个
 * client 条目没激活，DSH 就会整窗弹「应用无法启动」。我们这一半只做一件小事：
 * 账号菜单里加一行，不值得拥有让整个界面起不来的权力。所以改成由宿主用
 * `webServer.tapIndex` 直接把这个脚本塞进 index.html —— 它就是一段普通脚本，
 * 页面必然加载，出问题最多是少一行按钮。
 *
 * 仍然只依赖 DOM：那个菜单是 shell 自带 UI，Slot 树里没有 account/menu 座位
 * （侧边栏底部只有 `sidebar.footer.action`，是做「设置」旁边的动作位，不是这个
 * 弹出菜单）。所以克隆「退出登录」那一行、换掉文案与图标、插在它后面：克隆能
 * 让新行自动继承 shell 自己的行样式（图标槽、内边距、hover、深浅色）。
 */
(function () {
  if (window.__DSH_HOT_RESTART_MENU__) return
  window.__DSH_HOT_RESTART_MENU__ = 'v0.2.7'

  var VERSION = 'v0.2.7'
  var RESTART_URL = '/dsh-hot-restart/restart'
  var STATUS_URL = '/dsh-hot-restart/status'
  var REPORT_URL = '/dsh-hot-restart/report'
  var MENU_MARK = 'data-dsh-hot-restart-row'
  var LOGOUT_LABELS = ['退出登录', '登出', 'Sign out', 'Sign Out', 'Log out', 'Logout']
  var ICON_PATHS =
    '<path d="M20.4 12a8.4 8.4 0 1 1-2.9-6.31"></path><path d="M20.4 4.3v5.1h-5.1"></path>'

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
    } catch (error) {
      // 忽略：回执是排查用的，不是功能。
    }
  }

  /**
   * 当前界面语言。
   * @returns {string} 小写语言标签。
   */
  function language() {
    try {
      return String(navigator.language || '').toLowerCase()
    } catch (error) {
      return ''
    }
  }

  /**
   * 取当前语言的一侧文案。
   * @param {string} zh 中文。
   * @param {string} en 英文。
   * @returns {string} 选中的文案。
   */
  function pick(zh, en) {
    return language().indexOf('zh') === 0 ? zh : en
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
   * 在页面里找「退出登录」那一行（只在菜单打开时存在）。
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
          var row = textNodeHost.closest('button,[role="menuitem"],[role="button"],a,li')
          return row !== null ? row : textNodeHost
        }
      } catch (error) {
        // XPath 不可用时退回下面的遍历。
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
   * 等宿主把这次对账真正跑完，再让页面刷新。
   * @param {number|undefined} ticket 本次重启的票号。
   * @param {number} deadline 最晚等到什么时候。
   * @returns {Promise<any>} 对账结果；超时返回 null。
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
   * @param {HTMLElement} row 注入的那一行。
   * @returns {void}
   */
  function runFromMenu(row) {
    if (row.getAttribute('data-phase') === 'busy') return
    row.setAttribute('data-phase', 'busy')
    replaceRowText(row, pick('正在重启…', 'Restarting…'))

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
        replaceRowText(row, pick('正在重载插件…', 'Reloading plugins…'))
        return waitForSettle(ticket, Date.now() + 60000)
      })
      .then(function (run) {
        if (run !== null && run.ok === false) {
          throw new Error('reconcile failed: ' + String(run.detail))
        }
        replaceRowText(row, pick('正在刷新…', 'Reloading…'))
        window.setTimeout(function () {
          window.location.reload()
        }, 320)
      })
      .catch(function (failure) {
        var message = (failure && failure.message) || String(failure)
        row.setAttribute('data-phase', 'failed')
        row.setAttribute('title', message)
        replaceRowText(row, pick('重启失败，重试', 'Retry restart'))
        window.setTimeout(function () {
          if (row.isConnected === false) return
          row.setAttribute('data-phase', 'idle')
          replaceRowText(row, pick('热重启', 'Hot restart'))
        }, 3000)
      })
  }

  /**
   * 把「退出登录」那一行克隆重造成「热重启」，插在它下面。
   * @returns {boolean} 这一轮是否注入了。
   */
  function injectMenuRow() {
    if (document.querySelector('[' + MENU_MARK + ']') !== null) return false
    if (document.querySelector('[role="menuitem"]') === null) return false
    var row = findLogoutRow()
    if (row === null || row.parentNode === null) return false

    var clone = /** @type {HTMLElement} */ (row.cloneNode(true))
    clone.setAttribute(MENU_MARK, VERSION)
    clone.removeAttribute('aria-haspopup')
    clone.removeAttribute('aria-expanded')
    clone.removeAttribute('aria-controls')
    clone.setAttribute('data-phase', 'idle')
    replaceRowText(clone, pick('热重启', 'Hot restart'))
    clone.setAttribute('title', pick('重载插件并刷新界面', 'Reload plugins and refresh the page'))

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
      runFromMenu(clone)
    })

    row.parentNode.insertBefore(clone, row.nextSibling)
    report({ kind: 'menu-injected', at: Date.now(), row: clone.outerHTML.slice(0, 1200) })
    return true
  }

  /**
   * 盯着 DOM：账号菜单按需挂载/卸载，每次出现都把那一行补回去。
   * @returns {void}
   */
  function watch() {
    try {
      injectMenuRow()
      var scheduled = false
      var observer = new MutationObserver(function () {
        if (scheduled) return
        scheduled = true
        window.setTimeout(function () {
          scheduled = false
          try {
            injectMenuRow()
          } catch (error) {
            report({ kind: 'menu-error', at: Date.now(), error: String((error && error.message) || error) })
          }
        }, 60)
      })
      observer.observe(document.body, { childList: true, subtree: true })
      report({ kind: 'menu-watch', at: Date.now(), version: VERSION })
    } catch (error) {
      report({ kind: 'menu-watch-failed', at: Date.now(), error: String((error && error.message) || error) })
    }
  }

  if (document.body !== null) {
    watch()
  } else {
    document.addEventListener('DOMContentLoaded', watch, { once: true })
  }
})()
