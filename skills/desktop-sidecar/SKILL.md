---
name: desktop-sidecar
description: 用 desktop_* 工具直接操作这台 Windows 电脑的真实界面——看屏幕、读文字、点控件、打字、按键、滚动、拖拽、开程序、等状态。当用户要求「帮我点一下 / 打开 / 在某个软件里做某事」，或任务落在微信、QQ、Office、浏览器、网课客户端这类没有接口的软件上时使用。
whenToUse: 用户要在本机某个软件里完成动作（发消息、填表、点按钮、切页面），或需要先看清屏幕上有什么再决定下一步。网页任务走 desktop_web（先用不带 mode 的 open 让用户选内置/屏幕浏览器）；能走 HTTP/CLI 的优先走接口。桌面这条路留给「没有接口、只能像人一样点」的场合。
metadata:
  platform: windows
  tools: 20
---

# 桌面操作（desktop-sidecar）

把鼠标键盘交给模型：看屏幕、读字、点、输入、按键，全部作用在真实窗口上。
操作期间屏幕**右下角**会显示一条「DSH 正在操作这台电脑」的状态条，**用户随时按 Esc 可以中止**。

## 第一步永远是 desktop_look

`desktop_look` 一次给你：前台窗口、其他窗口标题、目标窗口的编号控件（`ref` 稳定、带名字和坐标）。
控件很少的窗口（Electron/画布类）它会**自动附带可读文字**，并告诉你该改走哪条路。

拿到 `ref` 之后：

- 点：`desktop_click{ref:"e7"}` 或 `desktop_click{name:"发送"}`
- 触发控件动作：`desktop_invoke{text:"确定"}`（按钮）、`{action:"toggle"}`（勾选框）
- 打字：`desktop_type{window, text}`（默认真按键，不动用户剪贴板）
- 填整个字段：`desktop_type{text, replace:true, field:"搜索"}`（走无障碍值，最快）

## 读文字：先 UIA，后 OCR

| 情况 | 用什么 | 为什么 |
| --- | --- | --- |
| Win32 / Office / 系统对话框 | `desktop_text{window}` | 读的是程序里的真文字，100% 准确，比 OCR 还快 |
| 网页 / Electron | 内置浏览器工具；其次 `desktop_text` | Chromium 的控件树几乎为空，但文字节点常常能读到 |
| 以上都读不到（游戏、Qt、自绘界面） | `desktop_read{window}` | 离线 OCR 兜底；小字号中文会认错，别把它当主力 |

OCR 认错字（把「人工智能」读成「人工智角牛」）是 Windows 自带引擎的短板，**不要**拿 OCR 结果去匹配按钮文字，
能用 `desktop_text` / 控件名字就别用 OCR。

## 慢程序：launch → wait

```
desktop_launch{target:"notepad"}        // 返回 hwnd / appPid / controlCount / treeReady
desktop_wait{window, kind:"text", text:"已登录", timeoutMs:8000}
desktop_wait{window, kind:"window", title:"导出完成"}
```

`desktop_wait` 的 `kind:"text"` 会先读无障碍文字、再退 OCR，命中会告诉你走的哪条路（`via`）。
不要用固定 sleep 猜加载时间。

## 网页任务：先问用户用哪种浏览器

网页**不要**直接上桌面点击。第一步调 `desktop_web{action:"open", url}`，**故意不带 mode**：
它会返回 `needChoice:true` 加两个选项（`internal` 内置浏览器 / `screen` 屏幕上的浏览器），每个选项都带 `good`（优点）/ `bad`（缺点）/ `bestFor`。

**问用户时要把两边的优缺点都摆出来，让用户自己选**，不要替他决定、也不要只报一个方案。照这个格式说：

> 网页这一步有两种做法，你挑一个：
> **A. 内置浏览器**——优点：后台跑不抢鼠标、读真实文字不会认错、独立配置可记住登录；缺点：你现有浏览器里的登录/插件不在里面（首次要登一下），纯图片/画布页面读不到字。
> **B. 你屏幕上的浏览器**——优点：用你平时那个，登录书签插件都在，你能看着每一步随时接手；缺点：我要模拟鼠标键盘，会抢前台、可能打断你，靠截图认字小字会认错。

选完再按用户的话重调（`mode:"internal"` 或 `mode:"screen"`）。

- `mode:"internal"`：后台独立浏览器，不抢鼠标、不动用户正在看的画面，适合登录、填表、抓信息。
  ```
  desktop_web{action:"open", mode:"internal", url:"example.com"}
  desktop_web{action:"snapshot"}                 // 返回标题/地址/正文 + 编号元素 [1]input "用户名"
  desktop_web{action:"type", ref:1, text:"张三"}
  desktop_web{action:"click", ref:4}
  desktop_web{action:"wait", waitText:"已提交"}
  ```
  页面一跳转，旧的 `ref` 就失效，**重新 snapshot** 再操作。填一整张表可以用 `fill{fields:[{label:"邮箱",value:"..."}]}`。
  内置浏览器**默认记住登录**（cookie/localStorage 落在 `%LOCALAPPDATA%\dsh-sidecar\web-profile`），下次接着用；要干净环境加 `profile:"temp"`，要清空用 `action:"reset"`。
- `mode:"screen"`：用用户自己的浏览器打开这个网址，之后走 `desktop_look` / `desktop_click` / `desktop_type`。

## 多步任务用 sequence

`desktop_sequence` 把 focus / click / type / key / scroll / drag / wait / read / screenshot 串成一次调用，
每步都能带 `ref` / `name` / `expect`，`dryRun:true` 先看计划。**多步任务优先用它**，别一步一步来回调用。

```json
{"steps":[
  {"action":"click","ref":"e3"},
  {"action":"type","text":"你好"},
  {"action":"key","key":"enter"},
  {"action":"wait","kind":"text","text":"发送成功"}
]}
```

## 常见失败怎么读

- `blocked:"POINT_COVERED"` + `covering` → 目标被别的窗口盖住，先 `desktop_window{action:"activate"}` 或请用户挪开。
- `blocked:"busy"` → 另一段对话正在操作桌面，稍等再试（同一时间只能一段对话操作）。
- `scrolled out of view` → 控件滚出可视区，先 `desktop_scroll` 再点。
- `changed:false` → 画面没变。点文字区可能只是移动了光标；按钮请改 `desktop_invoke`。
- `refused: secure desktop` → 锁屏 / UAC 确认界面，**不要重试**，请用户自己解锁或点确认。
- 窗口标题命中多个 → 返回里带 `windowAmbiguous` 和 `windowUsed`，看它实际用了哪个。
- `blocked:"protected-window"` → 这是系统对话框（「打开方式」等），Windows 不让程序送模拟鼠标：别再用坐标点，改用 `desktop_key`（`Tab` / `↓` 挪焦点、`Enter` 确认、`Esc` 取消）；内容可以先 `desktop_read` 读出来。
- 目标窗口在 `desktop_windows` 里显示为「系统对话框」（`protected:true`）→ 同上，走键盘。

## 边界

- 只在 Windows 上工作，其它平台 `desktop_doctor` 会直接说明。
- 锁屏、UAC 提权确认这类系统安全界面一律拒绝操作。
- 需要窗口能拿到前台；被系统拒绝时退回后台消息点击（部分程序不响应）。
- 每次操作都记进 `desktop_log`，排查「它到底点了哪」先看这个。
- OCR 依赖系统的「中文(简体)」语言包；`desktop_doctor` 的 `ocr` 项会告诉你缺不缺。

- `blocked:"focus"` — 浏览器里没点输入框就打字。先 `desktop_type{ref|name}`（先点后输），或改用 `desktop_web`。
