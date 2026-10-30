---
name: desktop-sidecar
description: 用 desktop_* 工具直接操作这台 Windows 电脑的真实界面——看屏幕、读文字、点控件、打字、按键、滚动、拖拽、开程序、等状态。当用户要求「帮我点一下 / 打开 / 在某个软件里做某事」，或任务落在微信、QQ、Office、浏览器、网课客户端这类没有接口的软件上时使用。
whenToUse: 用户要在本机某个软件里完成动作（发消息、填表、点按钮、切页面），或需要先看清屏幕上有什么再决定下一步。只读网页内容优先用浏览器工具；能走 HTTP/CLI 的优先走接口。桌面这条路留给「没有接口、只能像人一样点」的场合。
metadata:
  platform: windows
  tools: 19
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

## 边界

- 只在 Windows 上工作，其它平台 `desktop_doctor` 会直接说明。
- 锁屏、UAC 提权确认这类系统安全界面一律拒绝操作。
- 需要窗口能拿到前台；被系统拒绝时退回后台消息点击（部分程序不响应）。
- 每次操作都记进 `desktop_log`，排查「它到底点了哪」先看这个。
- OCR 依赖系统的「中文(简体)」语言包；`desktop_doctor` 的 `ocr` 项会告诉你缺不缺。
