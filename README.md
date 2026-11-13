# dsh-hot-restart-row

在**账号菜单**（侧边栏底部那张账号卡弹出的菜单）里、“退出登录”下面加一行 **热重启**。

菜单原本是 `设置 / 意见反馈 / 退出登录` 三行；现在变成四行，第四行就是这只按钮。

## 和市场上那个同名插件不是一回事

列表里已经有一个 [`xiaolu511/dsh-hot-restart`](https://github.com/xiaolu511/dsh-hot-restart)
（分类 `dev`）：它是 DSH 窗口里的一个固定按钮，点一下**把 DSH 关掉再自动重开**，右键还有内置自检。

这一个（`dsh-hot-restart-row`）做的是另一件事：

- **不杀进程、不重开窗口**：宿主只在自己的 Loader 树里重放 profile 的 patch（`hmr.reconcileProfile()`），
  然后页面刷新一次；DSH 主进程 pid 不变，其它会话不受影响。
- **落点在账号菜单里**（“退出登录”下面一行），不占窗口空间、不盖在任何内容上面。

一句话：那个是**冷重启**（换掉整个进程），这个是**热重启**（换掉运行时、保留上下文）。
两个都在列表里并不冲突——要重开进程的人用那个，改完插件想立刻生效、又不想丢正在跑的对话的人用这个。

## 它是怎么放进去的（为什么不是插槽）

那个菜单是 **shell 自带 UI**，Cordis 的 Slot 树里没有对应座位 —— `Slots.listSubTree`
全量核对过：整棵树里唯一的侧边栏底部动作位是 `sidebar.footer.action`，那是在“设置”旁边、
和这个弹出菜单不是一个地方；`settings.launcher` 是账号卡本体，不是菜单项。

所以客户端这一半做的是 **DOM 注入**：找到“退出登录”那一行 → `cloneNode(true)` → 换成
“热重启”的文案与图标 → 插在它后面。克隆而不是新建，是为了**自动继承 shell 自己的行样式**
（图标槽、内边距、hover、深浅色），菜单换皮时它跟着变。

菜单是按需挂载/卸载的（关掉就整段移除），所以用 `MutationObserver` 盯着 `document.body`，
每次菜单出现时把这一行补回去；已经在了就跳过。

代价：这个落点依赖“退出登录”那一行仍然存在且文案可识别（`退出登录 / 登出 / Sign out /
Sign Out / Log out / Logout` 六种写法都认）。哪天 shell 重做菜单，这一行会**静默消失**，
`GET /dsh-hot-restart/status` 与 `report.json` 是排查入口。

## 它到底重启什么

DSH 没有“重启进程”的 API（`agents` / `sessions` / `agentPresets` 都没有），所以这个按钮做的是
“**换掉运行时、保留上下文**”，这正是改完插件之后真正需要的那一步：

1. **宿主**：`POST /dsh-hot-restart/restart` → 后台在 `hmr.runExclusive()` 里调用
   `hmr.reconcileProfile()`，把 profile 的 patch 按磁盘上的内容重新对账进运行中的 Loader 树。
   增删插件行、改某一行的 `config` 之后不用关窗口就能生效。
2. **客户端**：按钮收到 200 后 `location.reload()`，页面重新拉 `index.html` 与 client bundle。

对话存在 durable session log 里，刷新只是重新渲染；agent 进程不动，
所以**当前对话不会丢**，也不会打断别的会话。

## 路由

同源，与 DSH 自带 Web 路由同一个信任边界，无额外鉴权：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-hot-restart/status` | 诊断 JSON：pid / 运行时长 / Node 与 Electron 版本 / profile 路径 / 活 agent / 最近重启历史 |
| GET, POST | `/dsh-hot-restart/restart` | 触发热重启：立即回 200，随后在后台对账插件树 |
| POST | `/dsh-hot-restart/report` | 客户端回执：把页面上注入到的行（`outerHTML`）落进包内的 `report.json` |

排查时直接开 `http://127.0.0.1:<port>/dsh-hot-restart/status` 即可。

## 实现要点

- 零依赖、纯 JS、**无构建步骤**：`index.js`（ES module，宿主）+ `runtime/menu.js`
  （普通 IIFE，被宿主读出来、由 `tapIndex` 插进 index.html）。
- **先回响应、再对账**：对账会把本插件所在 fiber 重新评估一遍，先 `await` 再回响应的话
  浏览器会拿到断掉的连接，按钮会误报“失败”。
- 对账必须套 `runExclusive`：`reconcileProfile()` 自己不加锁，直接调会抛
  `HMR profile reconciliation must run inside runExclusive`。
- **刷新前等图稳定 + 预热 bundle**：对账会重启一批 fiber，`clientModules` 每收到一个内部
  `plugin` 事件就重算一次图。页面若在这一代换代窗口里加载，会拿到上一代已经下线的 bundle
  URL，启动阶段直接 `import failed`。所以宿主在 `reconcileProfile()` 之后先用
  `settleGraph()` 等 `graph().rev` 连续 800ms 不变，再用 `warmBundles()` 把图里每个
  bundle GET 一遍并读完（本机实测 86 个 bundle 约 99ms 全 200）。两步都成功才允许刷新；
  否则按钮显示失败、页面不动——宁可让人再点一次，也不让页面带着 404 启动。
- 按钮没有 React 状态可借，进度直接写在 `data-phase`（`idle / busy / failed`）+ 行文案上，
  失败 3 秒后回到 `idle`。
- **首页自愈脚本**（0.2.5）：`webServer.tapIndex()` 把一段同步脚本插到 `</head>` 之前。
  它用捕获阶段的 `error` 监听接住任何 `/plugins/…` 分包的加载失败，然后重载页面
  （新页面拿的是当前 rev）。`sessionStorage` 计数限流 2 次/60 秒，避免真坏掉时无限刷新；
  每次触发都会往 `POST /dsh-hot-restart/report` 记一条 `kind: "boot-guard"`。
- **不再做 client 插件**（0.2.7）：`dsh.client` 的入口在 DSH 的启动关键路径上
  （`entries.start` 里任何一个条目没激活，整窗就报 `web boot: N entries did not activate`）。
  这一半只负责一行菜单，不值得拥有让界面起不来的权力 —— 所以宿主在 `tapIndex` 里把
  `runtime/menu.js` 作为普通行内脚本注入 `</body>` 之前，页面必然执行它，出问题最多少一行按钮。

## 安装

由 Harness 自己的 `plugin_manager` 安装（profile 里不要手动 pnpm、也不要手写
profile 的 `package.json` / `cordis.patch.yml`）：

| 操作 | 调用 |
| --- | --- |
| 安装 / 升级 | `plugin_manager` → `install_bundle`，`target` = 本目录的绝对路径 |
| 停用 | `plugin_manager` → `set_bundle`，`target: dsh-hot-restart-row`，`enabled: false` |
| 卸载 | `plugin_manager` → `remove_bundle`，`target: dsh-hot-restart-row` |

安装是 pnpm 的**链接**安装：本目录就是 profile 里的那一份（目录名仍是 `dsh-hot-restart`，
包名是 `dsh-hot-restart-row`），改完文件按下热重启即生效，不需要重装。

这个包也发布在 npm 上（`dsh-hot-restart-row@0.2.0`），别的机器可以直接装：

```sh
dsh plugin --profile desktop add dsh-hot-restart-row
```

> 客户端代码是在页面加载时取一次 bundle 的。改完 `client.js` 之后要**手动刷新一次页面**
> （Ctrl+R）才会用上新代码；宿主那一半则跟着插件重载立刻生效。

## 已实测（本机，Harness 桌面端）

- 宿主侧用“从自己进程内部打自己路由”的办法验过（这台机器上浏览器 provider 不可用、
  也没有 shell）：`GET /status` → 200，`pid` 与 Harness 主进程一致，profile =
  `C:\Users\Administrator\.dsh\profiles\desktop\`，`hmr.available: true`。
- `POST /restart` → 200；随后对账 `ok: true`、`tookMs ≈ 173`、结果 `{ warnings: [], pending: [] }`。
- 重启前后 `pid` 不变、四个活跃会话（agent + root）全部还在 ⇒ 不打断对话。
- 菜单注入：`report.json` 里记到的实况是——菜单容器
  `<div class="_itemWrap_4ub78_90">` 内，“退出登录”那个 `<button role="menuitem">`
  之后紧跟着注入出来的
  `<button role="menuitem" data-dsh-hot-restart-row="…"><span class="_itemIcon_…">svg</span><span class="_itemLabel_…">热重启</span></button>`
  ⇒ 位置正确、样式走的是 shell 自己的类名。

## 已知边界

- 按钮**不杀进程**：真正的冷启动（Electron `app.relaunch()`）没有对外 API，
  强行做会中断当前会话且无法自测。需要那个的时候用 `xiaolu511/dsh-hot-restart`。
- 对账只管“声明的行”：它让 profile 的插件树与磁盘上的 patch 一致（增删行、改 config），
  不做模块级源码热替换 —— 源码改动的热重载是 `dsh-hmr` 的文件监视在做的那件事。
- 对账是“尽力而为”：某个插件加载失败时，失败信息进 Host 日志与 `status` 的重启历史，
  按钮本身不会因此报错。
- 注入依赖 shell 的菜单文案：找不到“退出登录”就不注入（不会乱插到别处）。

## 上架到插件市场

市场（[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)）收录的是
**GitHub 仓库 + 一个 YAML 条目**，不是压缩包：

- 仓库：`https://github.com/TelethaMithril/dsh-hot-restart-row`（本目录就是仓库根）
- 条目文件：`market/TelethaMithril__dsh-hot-restart-row.yml` → 提交到
  `awesome-dsh-plugin` 仓库的 `data/plugins/TelethaMithril__dsh-hot-restart-row.yml`
- 分类：`ui`

本仓库满足收录硬条件：`package.json` 声明了 `dsh.bundle`（不只是 `dsh.client`）、
旁边有 `cordis.patch.yml`、真实代码、零依赖、无构建步骤、没有 `@deepseek-ai/*` 依赖。

逐步命令（推仓库 / 加 topic / 提 PR / 可选 npm）见 [`market/PUBLISH.md`](market/PUBLISH.md)，
一键推仓库用 `pwsh -File market/publish.ps1`。

上架之后用户那边的安装命令形如：

```sh
dsh plugin --profile desktop add "github:TelethaMithril/dsh-hot-restart-row#main"
```

## 变更记录

- **0.2.7** — 删掉 `dsh.client` 半边，把菜单代码挪到 `runtime/menu.js`，由宿主用
  `webServer.tapIndex()` 作为普通行内脚本注入 `</body>` 之前。原因：client 条目在
  DSH 启动关键路径上，`entries.start` 里只要有一个条目没立起来，整窗就弹
  「应用无法启动」（现象是 `dsh-hot-restart-row: import failed (see console for the import error)`，
  而且 `importError` 为空 —— 说明 bundle 没坏，是启动时序）。改成注入脚本后，本插件
  在任何情况下都不可能再让 web boot 失败；代价只是注入失败时菜单里少一行。
  同时删掉 0.2.6 期间的只读诊断路由 `/dsh-hot-restart/diagnose`。

- **0.2.6** — 两处“宁可少个按钮，也不能让整窗起不来”的加固：
  ① 宿主装配（`activate`）整段包了 try/catch，出错只写进 `report.json` 并由 `/status` 的
  `activationError` 暴露，不再把异常抛回 Loader（那会让 DSH 报 `entries did not activate`
  并弹「应用无法启动」）；② 客户端 `apply` 同样兜底，并且启动时会先发一条
  `{"kind":"client-apply","version":…}` 回执 —— 下次再出问题，报告里有没有这一条就能
  立刻区分“模块没加载”还是“加载了但别处挂了”。
  另外首页自愈脚本新增“启动失败屏”检测：分包没报错、但页面停在
  「应用无法启动 / did not activate」时，带一次 `?hr-bust=` 重载（同一套 60 秒 2 次限流）。
- **0.2.5** — 首页注入一段自愈脚本：`/plugins/…&rev=…` 的分包脚本加载失败时，
  带当前 rev 自动重载一次（`sessionStorage` 限流：60 秒内最多 2 次，之后交回 DSH 自己的报错）。
  这一条不依赖本插件的按钮 —— 市场装完插件后自己的 `location.reload()`、或任何插件
  在对账中途换图，都可能让页面带着过期 rev 起来并卡在「应用无法启动」，
  现在它会自己重试一次。脚本在 `</head>` 之前、经典脚本、同步执行，早于 deferred 入口模块。
- **0.2.4** — 刷新前先等插件图稳定、并预热全部 client bundle；任何一步失败都不刷新页面。
- **0.2.3** — 重启进度改挂 `globalThis`：对账过程中本模块若被重新 import，模块级变量会归零、客户端就永远等不到自己的 ticket；挂全局后重载也读得到。
- **0.2.2** — 修掉一个会让 DSH 起不来的竞态：以前 `POST /restart` 回完 200，页面固定
  450ms 后就 `location.reload()`；如果对账还在跑（刚在市场装完插件时尤其容易，因为
  要排在 plugin-manager 自己的对账后面），页面会在 clientModules 换 bundle 版本的中途
  加载，拿到旧 `rev` 的分包 URL 直接 404，启动阶段就会报
  `web boot: N entries did not activate`（日志里是 `bundle script ... failed to load`）。
  现在宿主给每次重启发一个 `ticket` 写进 `lastRun`，客户端轮询 `/status` 等
  `lastRun.finishedAt` 落定再刷新，超时 30s。
- **0.2.0** — 按钮改到账号菜单“退出登录”下面（DOM 注入），侧边栏按钮移除。
