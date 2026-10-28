---
name: desktop-sidecar
description: 用 desktop_* 工具直接操作这台 Windows 电脑的真实界面——看屏幕、读文字、点控件、打字、按键、跑多步序列。当用户要求「帮我点一下 / 打开 / 在某个软件里做某事」，或任务落在微信、QQ、Office、浏览器、网课客户端这类没有接口的软件上时使用。
whenToUse: 用户要在本机某个软件里完成动作（发消息、填表、点按钮、切页面），或需要先看清屏幕上有什么再决定下一步。只读网页内容优先用浏览器工具；能走 HTTP/CLI 的优先走接口。桌面这条路留给「没有接口、只能像人一样点」的场合。
metadata:
  platform: windows
  tools: 12
---

# 桌面操作（desktop-sidecar）

这套工具就是把鼠标键盘交给模型：截屏、读字、点、输入、按键，全部直接作用在真实窗口上。
操作期间屏幕底部会显示一条「DSH 正在操作这台电脑」的状态条，**用户随时按 Esc 可以中止**长任务。

## 先看，再动手

1. `desktop_windows` — 先确认目标窗口在不在、标题是什么（原生枚举，~2ms）。
2. `desktop_read` — 读这个窗口的文字（离线 OCR）。不知道界面上有什么时先读一遍。
3. 有 UI 自动化接口的软件（Office、资源管理器、系统对话框、大部分 Win32 程序）：
   `desktop_tree` 拿到编号控件树，再用 `desktop_click{control:N, expect}` 或
   `desktop_invoke{text, role}` 精确触发——比按坐标点可靠得多。
4. 没有 UIA 的软件（微信、Qt 程序、Electron、游戏）：用 `desktop_click{text}` 按 OCR 文字点，
   或 `desktop_click{fx, fy}` 按比例点。

## 一次做完多步

`desktop_sequence` 把 focus / click / type / key / scroll / wait / read / screenshot 串成一次调用，
每步都会重新抢前台、能带 `expect` 校验，`dryRun:true` 可以先看计划。多步任务优先用它，
不要一步一步来回调用——既慢又容易点空。

## 常用配方

- **在微信里发消息**：`desktop_windows` 找微信 → `desktop_click{text:"文件传输助手"}` →
  `desktop_click{fx:0.5, fy:0.92}`（输入框）→ `desktop_type{text}` → `desktop_key{key:"enter"}`。
- **填网页表单**：优先 `desktop_tree{query:"输入"}` 找 Edit 控件 → `desktop_invoke{text, action:"focus"}`
  → `desktop_type`；没有 UIA 就按 OCR 文字点。
- **点不动/点空了**：`desktop_click` 返回 `changed:false` 时会自动重试并重新 OCR 定位一次；
  仍失败就看返回的 `hint` 和 `lines`（窗口当前真实文字），换 `control`/`name` 方式点。

## 已知边界

- 只在 Windows 上工作；其它平台 `desktop_doctor` 会直接说明。
- 锁屏、UAC 提权确认这类**系统安全界面一律拒绝操作**（返回 `refused: secure desktop`），
  需要用户自己在电脑上解锁或确认。
- 需要窗口能拿到前台；被系统拒绝时会退回后台消息点击（部分程序不响应）。
- 每次操作都会记进 `desktop_log`，排查「它到底点了哪」时先看这个。
- OCR 依赖系统的「中文(简体)」语言包；`desktop_doctor` 的 `ocr` 项会告诉你缺不缺。
