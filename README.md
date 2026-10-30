# dsh-desktop-sidecar

给 DeepSeek Harness 加一双「手」：让 AI 在 Windows 上真正操作你的电脑——看屏幕、读文字、点按钮、打字、按快捷键，包括微信、Office、浏览器、网课播放器这些没有自动化接口的软件。

装一个 npm 包就能用，不需要另外装 Python、驱动或中间服务。

操作时屏幕底部会出现一条状态条（深色圆角小卡片，左边一个青色呼吸点，右边显示进度，比如 `3/7`；整条不抢焦点、鼠标能穿过它），用户按 Esc 可以随时叫停。

## 写在前面

这个插件是我自己用 DSH 时做的：有些事明明「让它帮我点一下」就完了，却还得自己动手，于是动手写了它。

我不是专业做这个的，代码是一个人业余时间写的，能力和精力都有限，肯定还有没考虑周全的地方。你如果在用的时候遇到 bug、或者觉得哪里别扭，欢迎来提 [Issue](https://github.com/111xjyuan/dsh-desktop-sidecar/issues)——你的反馈是它变好的主要来源。功能建议也欢迎，我不一定都能做，但会认真看。

**现在它能做的：**

- 列出当前有哪些窗口，找到你要操作的那个
- 读出窗口里的文字（Windows 自带离线 OCR，中文优先）和控件结构
- 点按钮、点文字、点坐标——点完会截图比对，界面没变就重试或告诉你原因
- 输入中文（走剪贴板，稳）、按任意组合键
- 一次调用跑完一串步骤，中途可以按 Esc 停下
- 网课自动播放：判断是否在播、自动切下一节
- 每次操作都有屏幕提示 + 操作日志，随时能查它到底点了哪儿
- 锁屏、UAC 提权确认这类系统安全界面一律拒绝，不会乱按

## 工具一览

```
desktop_windows  → 现在有哪些窗口
desktop_tree     → 这个窗口有哪些控件（UIA 控件树，带编号索引，可直接点）
desktop_invoke   → 直接触发控件（不移动鼠标、不需要窗口在前台）
desktop_read     → 窗口里写了什么（离线 OCR，带坐标）
desktop_capture  → 截图：直接作为图片返回，带坐标尺 + 缩放契约，画面没变就不重复发
desktop_click    → 点控件（编号或名字）/ 点文字 / 点坐标（点后像素校验）
desktop_sequence → 批量：一次调用跑多步（dryRun / stopOnError / Esc 中止）
desktop_type     → 输入中文（剪贴板 + 真 Ctrl+V，稳）
desktop_key      → 按键 / 组合键
desktop_course   → 网课自动播放（帧差判播放 + 自动下一节）
desktop_log      → 操作日志：每次点击/输入/按键都记了一条，可回看可清空
desktop_doctor   → 环境自检（平台 / DPI / 多屏 / OCR / 前台锁 / 输入控件 / 状态条 / 安全桌面）
```

## 它是怎么做的

同一件事，Windows 上通常有两条路，插件会自动选：

| 应用类型 | 识别方式 | 说明 |
|---|---|---|
| 记事本、Office、资源管理器、设置、WinUI 应用 | **UIA 控件树** | `desktop_tree` 拿到按钮/菜单的名字与能力，`desktop_invoke` 直接触发——不移动鼠标、不需要前台，最稳也最省 token；要点击就先 `desktop_click{name,role}`（按名字，不会过期） |
| 微信、VS Code、Discord、Electron/Qt 自绘界面 | **OCR + 坐标点击** | 这些应用不实现 UIA，`desktop_tree` 会返回空并自动附一段 OCR 摘要；用 `desktop_read` 找字、`desktop_click` 的 `text` 参数按字点击 |

经验法则：**能用 `desktop_invoke` 就别用 `desktop_click`；能按文字点就别按坐标点。**

截图会作为图片返回给支持看图的模型，但每条能力都留了纯文本路径（控件树 / 离线 OCR / 坐标），所以纯文本模型也能跑完整流程。

真实场景里它是这样干活的——发微信（`desktop_click` 按文字定位 → `desktop_type` 粘贴 → `desktop_key` 回车，点完会比对像素确认界面真的变了）：

（这里原本放了截图，考虑到截图里带着我自己电脑上的聊天列表和课程页面，已经撤掉——不想把个人内容放进公开仓库。）

遇到没有接口的网课页，用离线 OCR 读出题目和选项，再按坐标点：

### 操作时的屏幕提示与日志

- **状态条**：只要它真的要动鼠标键盘，屏幕底部就会出现「DSH 正在操作这台电脑」，第二行是当前动作，右下角是批量任务的进度；1.4 秒没有新动作自动收起。它不抢焦点、鼠标可以穿透。
- **Esc 中止**：批量任务、盯课过程中按住 Esc，当前这一步做完就停，返回 `cancelled:true`。
- **操作日志**：每次点击/输入/按键都会记一条（时间、工具、窗口、坐标、结果、是否重试），用 `desktop_log` 回看：`{"limit": 30}`，`{"clear": true}` 归档并清空。文件在 `%TEMP%/dsh-sidecar/actions.jsonl`。
- **安全桌面拦截**：锁屏、UAC 提权确认、切换用户这些系统安全界面，所有模拟输入都会被拒绝并返回 `refused: secure desktop`——不会去按「是」，也不会往锁屏密码框里打字。

## 更新记录

### 0.5.4（让你看得见它在做什么）

- **屏幕状态条**：真正操作时屏幕底部出现提示条（进程内 GDI 自绘，不装任何东西、不抢焦点、鼠标穿透），空闲 1.4 秒自动收起。
- **Esc 随时中止**：`desktop_sequence` / `desktop_course` 跑长任务时按 Esc 就地停下，返回 `cancelled:true`。
- **操作日志 + `desktop_log`**：每次点击/输入/按键都记一条，可回看最近 N 条、可归档清空。出了「它到底点了哪儿」这种问题，先看这里。
- **安全桌面拦截**：锁屏 / UAC / 切换用户界面一律拒绝操作（`refused: secure desktop`）。
- **点空了会自动重新定位**：按文字点击后界面没变时，重新 OCR 找一次再点，而不是对着老坐标傻点。
- **新增技能说明** `skills/desktop-sidecar/SKILL.md`：告诉模型先看后动、能用控件就别用坐标。
- `desktop_doctor` 增加状态条、操作日志、安全桌面三项自检。

### 0.5.3（修 issue #3 #4）

- **`desktop_invoke` 不再猜**：名字完全相同的控件优先；同名或子串命中多个时**一个都不点**，返回 `ambiguous:true` + `candidates` 列表，让你改用精确名字或加 `role`。新增 `match: auto|exact|substring` 与 `role` 参数。
- **`desktop_click` 支持按名字点**：`{name:"按钮文字", role:"Button"}`，点击时才定位控件，不像 `control:N` 那样会因界面变化而失效。
- **`+` 键终于能按了**：`desktop_key{"key":"+"}` / `"ctrl++"` 以前报 unknown key，现在按 Shift+ 正确打出加号。
- **`desktop_doctor` 的 DPI 不再误报**：改为查询进程真实 DPI 感知级别（`GetProcessDpiAwareness`）。宿主已预设时 Setter 返回 false 属正常，不再判失败。
- **`desktop_capture` 参数说明**：`x/y/width/height` 只在区域截图时生效，给了 `window` 就按整窗。

### 0.5.0（补齐自检与批量）

- **DPI 感知**：启动即声明 per-monitor v2，并在 `desktop_doctor` 里体检——125%/150% 缩放下坐标不再偏。
- **截图直接给模型看**：`desktop_capture` 返回 image block，图上叠了坐标尺（顶部 x、左侧 y，单位是客户区像素）。
- **帧去重**：同一窗口画面没变时返回 `unchanged:true` 且不重复附图，省 token。
- **批量**：`desktop_sequence` 一次调用跑多步，支持 `dryRun`、`stopOnError`、步骤上限 24，按住 **Esc** 可随时中止。
- **控件索引点击 + 身份校验**：`desktop_tree` 返回编号，`desktop_click{control:N, expect:{role,name}}` 会重读控件树核对身份，控件挪位就拒点而不是点错。
- **控件过滤**：`meaningfulOnly`（默认开）把装饰性容器滤掉并给出 `controlTotal / filteredOut`，几百个元素降到几十个。

## 3 分钟上手

1. 安装，任选一种：

   ```
   # A. npm（推荐）
   plugin_manager install_bundle dsh-desktop-sidecar

   # B. 插件市场：搜 desktop-sidecar

   # C. 本地源码（开发用）
   plugin_manager install_bundle file:<本目录绝对路径>
   ```

2. **先自检**，有异常会直接给修复建议：

   > 调用 `desktop_doctor`

   期望 `ok: true`，四项：`platform / ocr / foreground / editable-child`。

3. 让它干一件事，例如：

   > 打开记事本，写一句“你好，世界”

   模型会依次走 `desktop_windows` → `desktop_type` → `desktop_read` 验证。

## 常见问题

**OCR 返回 0 行？**
系统缺「中文(简体)」OCR 语言包。设置 → 时间和语言 → 语言 → 添加中文(简体) → 可选功能勾选「光学字符识别」。`desktop_doctor` 会直接指出这条。

**点了没反应？**
看返回里的 `changed` 和 `hint`。`changed:false` 且 `inClient:true` 多半是点在了纯文本区（光标移动也算成功）；按钮/菜单请改 `desktop_invoke` 或 `desktop_key`。

**截图拍到了别的窗口？**
工具会先把目标窗口抬到最上层再截；仍不对就先把它切前台（`desktop_invoke` + `focus`，或手动点一下）。

**中文变成乱码？**
`desktop_type` 用剪贴板 + 真 Ctrl+V，正常不会乱；若目标应用禁用粘贴，改用 `desktop_key` 逐键发送。

**管理员窗口点不动？**
Windows UIPI 限制：非提权进程不能向提权窗口发送输入。用管理员身份启动 DSH。

## 权限与安全

- 一切操作都在**你本机的桌面会话内**，只能做你自己能做的操作。
- 不上传屏幕内容或文字；OCR 用 Windows 本地引擎，**完全离线**。
- 截图临时文件在 `%TEMP%\dsh-sidecar`，**超过 1 小时自动清理**。
- 前台锁、UIPI、锁屏/安全桌面这类系统限制**不会被绕过**——这是设计选择，不是缺陷。

## 平台

Windows 10 1809+ / Windows 11，x64 与 arm64。

macOS / Linux 未实现（需要完全不同的辅助功能 API，暂不在计划内）。

## 开发

```bash
# 开发期把它同步进 DSH profile 的 node_modules，避免每次重装
powershell -NoProfile -File scripts/sync.ps1
```

改完 `lib/` 后在 DSH 插件面板「禁用 → 启用」即可热重载，无需重启。

依赖：`koffi`（原生 FFI）；peer `@deepseek-ai/dsh-tools >= 0.1.5-rc.1`。

## English

**dsh-desktop-sidecar** gives DeepSeek Harness a pair of hands on Windows: it lists windows, reads text with the built-in offline OCR, presses UIA controls by name, clicks by text or coordinates (with pixel-diff verification), types Chinese through the clipboard, and runs multi-step sequences — including apps with no automation API such as WeChat, Office and course players.

- Native Win32 via `koffi`: no Python, no drivers, no helper service.
- Every mutating action shows a small "DSH is controlling this computer" bar on screen; hold `Esc` to abort a sequence.
- Every action is logged (`desktop_log`), so you can always see what it did.
- Secure desktop (lock screen / UAC) is refused, never automated.
- `desktop_doctor` self-checks platform, DPI awareness, monitors, OCR, foreground lock and more.

```
dsh plugin add dsh-desktop-sidecar
```

Requires Windows 10/11. Feedback and bug reports are very welcome — see [Issues](https://github.com/111xjyuan/dsh-desktop-sidecar/issues).

## 许可

MIT
