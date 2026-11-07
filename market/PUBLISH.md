# 上架到 dsh 插件市场

目标仓库/条目已经定好：

- GitHub 仓库：`https://github.com/TelethaMithril/dsh-hot-restart-row`
- 市场条目文件：`market/TelethaMithril__dsh-hot-restart-row.yml`（内容就是最终要放进
  `awesome-dsh-plugin` 仓库 `data/plugins/` 里的那一个文件）
- 分类：`ui`（市场 UI 增强）

> 为什么叫 `-row`：列表里已经有一个 `xiaolu511/dsh-hot-restart`（`dev` 类，按钮在窗口里、
> 点一下把 DSH 关掉再重开）。我们这只做“原地对账插件树 + 刷新页面、不杀进程”，
> 名字带上 `row` 既点明落点（菜单里的一行），也不再和它撞同一个显示名。

市场的列表不是“提交一个 zip”，而是 **GitHub 仓库 + 一个 YAML 条目**：

- 插件本体放在你自己的 GitHub 仓库里，用户直接从这个仓库安装。
- 列表数据在 `awesome-dsh-plugin/awesome-dsh-plugin` 仓库的 `data/plugins/`，一个插件一个
  `<owner>__<repo>.yml`；`README.md` / `README.zh.md` 由脚本生成，**不要手改**。

所以“上架”= ① 把本目录推成 GitHub 仓库；② 给 `awesome-dsh-plugin` 提一个只加一个 YAML 文件的 PR。

---

## 第 1 步：推成 GitHub 仓库

先在 GitHub 上建一个 **public** 仓库 `dsh-hot-restart-row`（不要勾选 “Add a README”，本目录已经有）。
然后在 PowerShell 里（目录名保持 `dsh-hot-restart`，包名是 `dsh-hot-restart-row`）：

```powershell
cd C:\Users\Administrator\Documents\deepseek-harness\default-workspace\dsh-hot-restart

git init -b main
git add -A
git commit -m "dsh-hot-restart-row: Hot restart row under Sign out"
git remote add origin https://github.com/TelethaMithril/dsh-hot-restart-row.git
git push -u origin main
```

或者用附带的脚本（同一件事，多做了“有没有改动”的判断）：

```powershell
pwsh -File market/publish.ps1
```

如果 `git commit` 抱怨 `Please tell me who you are`，先设一次身份：

```powershell
git config --global user.name  "TelethaMithril"
git config --global user.email "你的邮箱"
```

## 第 2 步：仓库侧两件必做

1. 仓库 **Settings → Topics** 加 `dsh-plugin`（CI 会查这一项）。
2. 仓库必须**创建满 1 天**才能过 gate。刚建好就提 PR 会被自动挡下，这不记为拒绝：第二天在同一个
   PR 分支上 push 一次（或等 gate 自动重跑）就过。

## 第 3 步：提 PR —— 只加一个文件

1. fork `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`
2. 把本目录的 `market/TelethaMithril__dsh-hot-restart-row.yml` 复制到该仓库的
   `data/plugins/TelethaMithril__dsh-hot-restart-row.yml`（文件名不要改）
3. 只提交这一个文件，**不要动 README**；一个 PR 最多 3 条，我们只提 1 条
4. PR 正文写一句即可：`Add dsh-hot-restart-row (ui): Hot restart row under Sign out.`

CI 依次检查：条目数 → 仓库 `package.json` 里的 `dsh.bundle` → 仓库年龄 ≥ 1 天 → awesome-lint 与站点构建。

本仓库已经满足的硬条件：

- `package.json` 里有 `dsh.bundle.patch: ./cordis.patch.yml`，旁边就是 `cordis.patch.yml`
  （`- insert: [{ id: dsh-hot-restart-row, name: dsh-hot-restart-row }]`）——这是最常被拒的一项，
  只有 `dsh.client` 是**装不上**的。
- 真实可用的代码（宿主路由 + 客户端注入），零依赖、无构建步骤，源码即产物。
- 没有 `@deepseek-ai/*` 依赖，所以不涉及 peer 依赖的预发布范围坑。
- 描述只说它做的事：菜单里加一行“热重启”，重载 profile 插件树并刷新窗口、对话不丢。
  没有数字、没有 API 名可以夸大——评审会逐条对着代码核。

## 可选：npm / 图标 / 截图

- **npm**（可选，发了好处是市场能显示下载量）：
  ```powershell
  npm publish --access public
  ```
  `package.json.repository` 已经指回上面的仓库（否则市场和 npm 包关联不起来）。
  条目里**不要**手写 `npm:` 键，写了会被校验拒绝。
- **图标**：条目里的 `icon:` 必须是 GitHub 托管的**位图**（png/jpg/webp），**SVG 会被拒**。
  仓库里只有 DSH 自己用的 `icon.svg`，所以条目暂时不写 `icon`，市场会回退到你的 GitHub 头像。
  想要自己的卡片图标：放一张方形 `assets/icon-180.png` 进仓库，再给条目加
  `icon: https://raw.githubusercontent.com/TelethaMithril/dsh-hot-restart-row/main/assets/icon-180.png`。
- **截图**（可选，推荐）：在仓库根放 `screenshots.json`，列出 1–8 张仓库内图片的相对路径。
  这个文件放在你自己的仓库里，不用来提交 PR；以后换图推自己仓库即可，下次构建自动生效。
  不写也可以，市场会从 README 里抽图。

## 上架之后

- 站点列表 `https://awesome-dsh-plugin.com/plugins.json` 由构建重新生成；`dshmarket` 是实时拉取，
  合并后不用做别的。
- 用户安装：在市场的“从 Git 安装”里填 `https://github.com/TelethaMithril/dsh-hot-restart-row`，
  或直接跑 CLI 的 git 源形式（社区里同类的写法都长这样，profile 名按实际替换）：

  ```sh
  dsh plugin --profile desktop add "github:TelethaMithril/dsh-hot-restart-row#main"
  ```

  零依赖、无构建步骤，不需要 `allowBuilds` 授权。
- 以后更新插件：直接推自己的仓库（自己定版本号/tag），市场按仓库内容安装；
  条目描述要改的话，另开一个**只改自己那一条**的 PR。

## 在本机验证过的

- **注入**：v0.2.0 的注入在活页面里跑过两次（`report.json`：`2026-11-07T06:01:24Z`、
  `06:03:43Z`），落盘的行是 `data-dsh-hot-restart-row="v0.2.0"`，紧跟在“退出登录”的
  `<button role="menuitem">` 之后，样式沿用 shell 自己的 `_item_*` 类名。
- **重启**：`POST /dsh-hot-restart/restart` → 200 → 后台对账 `ok: true`、`tookMs ≈ 173`、
  `{ warnings: [], pending: [] }`；`pid` 不变、四个活跃会话全在（详见 README「已实测」）。

## 已知边界（写在这里，省得评审时被问）

- 按钮**不杀进程**：DSH 没有对外的 `app.relaunch()` 等价能力，硬做会中断当前会话。
  它做的是“换掉运行时、保留上下文”：`hmr.runExclusive(() => hmr.reconcileProfile())` + 页面刷新。
- 客户端这一半是 **DOM 注入**（那个账号菜单在 Slot 树里没有座位），依赖菜单里“退出登录”那一行
  仍然存在、文案仍可识别（`退出登录 / 登出 / Sign out / Sign Out / Log out / Logout`）。
  shell 哪天重做菜单，这一行会静默消失——`GET /dsh-hot-restart/status` 和 `report.json` 是排查入口。

## 和已有相近插件的关系（PR 里可以顺带说一句）

列表里已经有几个相邻的东西，投稿前心里有数：

- [`xiaolu511/dsh-hot-restart`](https://github.com/xiaolu511/dsh-hot-restart)：**窗口里的固定按钮**，
  点一下把 DSH 关掉再自动重开（冷重启），右键有内置自检——名字相同，机制相反。
- [`stuarthu/dsh-hot-reload`](https://github.com/stuarthu/dsh-hot-reload)：改完插件就地热重载，
  失败回滚并提示需要重启——它做的是**模块级热替换**。
- [`KYinCode/dsh-hot-installer`](https://github.com/KYinCode/dsh-hot-installer)：装/卸/升级插件
  即时生效的热管理器。
- [`julensun-ir/DSH-RESTART-TOOL`](https://github.com/julensun-ir/DSH-RESTART-TOOL)：**重启/关闭
  dsh web 服务**（含侧边栏电源控制）。

我们和上面四个都不重叠的地方：落点是**账号菜单里“退出登录”下面的一行**，动作是
`hmr.runExclusive(() => hmr.reconcileProfile())` + 页面刷新——不杀进程、不重开窗口、
不换 Profile、不接管安装/升级，也不做模块级热替换。如果评审认为“已被覆盖”，那是平局裁决，
不是硬性拒绝；PR 里写清这一句即可。
