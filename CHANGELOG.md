# 更新日志

## 0.6.0 — 2026-10-30

- **新工具 `desktop_look`**：一次调用返回「前台窗口 + 窗口列表 + 可点控件（带编号、名字、位置、可用动作）+ 可选 OCR 文字 + 可选带编号的截图」。以前要连着调 `desktop_windows` + `desktop_tree`(+`desktop_read`)，现在一步到位；截图上的编号是给模型引用的短标记（配 5x7 点阵自己画的，不依赖字体）。
- **新工具 `desktop_launch`**：启动程序 / 打开网址或文件，并等它的窗口真的出现再返回 hwnd（少一次「等它起来」的猜测）。
- **新工具 `desktop_wait`**：等到条件成立再继续——`window`（窗口出现/消失）、`text`（文字出现）、`change`（画面变化）、`idle`（界面安静下来）。之前只能靠固定 sleep 猜。
- **新工具 `desktop_text`**：用无障碍文本直接读窗口/输入框的真实文字（`TextPattern` → `ValuePattern`），读不到才退回 OCR；返回值带 `source`，让模型知道该不该信。
- **截图带编号**（set-of-marks）：`desktop_look{image:true}` 会把可点控件的编号画在截图上，小框互相压住时标签自动往上叠。
- **`desktop_invoke` 参数更宽容**：`text` 与 `name` 互为别名，控件名误写进 `match` 也能认；报错会说清楚「要用 text 传控件名」。
- **`desktop_type` 不再动用户的剪贴板**：粘贴前记住原来的剪贴板，输入完再恢复（长文本跳过）。
- **读剪贴板**：新增 `win32.getClipboardText()`，`OpenClipboard` 被别的程序短暂占用时会重试。
- **新工具 `desktop_scroll` / `desktop_drag` / `desktop_window`**：滚轮（含横向，返回 `changed` 判断是否到底）、按下-拖动-松开、窗口激活/最小化/最大化/还原/移动/关闭。此前这几件事只能靠坐标点击硬凑。
- **免重读的点击**：`desktop_look` 给每个控件一个短引用 `ref`（如 `e7`），`desktop_click{ref:'e7'}` 直接点，省掉一次控件树读取，也不会因为树变了而点到别处。
- **点前挡住检查**：`desktop_click` 点击前用 `WindowFromPoint` 确认落点没被别的程序盖住（通知、弹窗最常干这事），挡住就返回 `blocked:'POINT_COVERED'` 并说明是谁挡的；同一进程的菜单/弹框放行，`force:true` 可跳过。
- **点完把电脑还给你**：默认点完把鼠标移回原处、把前台还给原来的窗口（`restore:false` 关掉），返回值带 `restored`。
- **同一时间只做一件事**：所有会动键鼠的工具共用一把忙锁，另一路调用直接返回 `blocked:'busy'`，不会两条对话同时抢鼠标。
- **`desktop_type` 直接写值**：输入框支持 `ValuePattern` 时直接写（后台、不动剪贴板、不等光标），写完回读校验；不支持才退回「聚焦 + 粘贴」。
- **浏览器优先提示**：`desktop_windows` / `desktop_look` 发现浏览器窗口时会提示「网页任务优先用内置浏览器工具」，避免用像素点击去操作网页。
- **稀疏树提示**：控件树几乎是空的时候（Chromium/Electron 常见）直接给出三条替代路线：内置浏览器工具 / `desktop_text` 读字 / 截图 OCR 点击。
- **精简模式**：环境变量 `DSH_SIDECAR_TOOLS=lite` 只暴露 11 个常用工具，给上下文吃紧的场景。
- **状态条移到右下角**：不再挡在屏幕中间。
- **不再往临时目录堆截图**：`desktop_capture` 以前每次都会写一个 png 到 `%TEMP%\dsh-sidecar`，用久了会占几百 MB。现在只有传 `path` 或 `saveFile:true` 才落盘，其余情况图片只作为附件返回。
- **同名窗口不再悄悄点错**：一个标题命中多个窗口时，仍然用最靠前的那个，但返回值会带 `windowAmbiguous` + `windowUsed` + 一句提示（只统计真正看得见的窗口，后台隐形窗不参与）。
- **中文叫法兜底**：窗口名支持常见中文别名（记事本→Notepad、计算器→Calculator、浏览器→Edge/Chrome…），不用先查一次英文标题。
- **窗口列表更干净**：过滤掉 DWM 隐形窗、没有任务栏入口的工具窗、无标题栏的弹出层、各硬件驱动的辅助窗口，以及本插件自己的状态条。以前 `desktop_windows` 会把这些一起吐出来（能有几十行噪音）。
- **`desktop_launch` 返回真正的应用 pid（`appPid`）**：以前给的是启动器的 pid（`start notepad` 时是 cmd 的 pid），拿它去结束进程会杀错。
- **`desktop_launch` 等控件树补齐**：窗口出现 ≠ 能操作。现在会再等 0.2~1.6 秒让控件树稳定下来，并带回 `controlCount` / `treeReady`，避免紧接着 `desktop_look` 只看到半棵树。带空格的文档路径也补了引号，不会被 `cmd start` 拆开。
- **`desktop_wait kind=text` 先读无障碍文字**：能在 UIA 里找到就直接返回（快、准、不怕窗口被挡），找不到才 OCR；返回里带 `via`。
- **点不到就明说**：控件滚出可视区（坐标为负或落在窗口外）时 `desktop_click` 直接拒绝并说明，不会点到旁边去。
- **动作不支持时给下一步**：`desktop_invoke` 命中的控件没有该动作时，报错会说明它支持哪些动作（例如「支持 Toggle、ScrollItem」），而不是只说一句 no pattern。
- **`desktop_sequence` 支持 `ref`**：步骤里可以直接 `{action:'click', ref:'e7'}`；dryRun 的计划文本也不再输出 `fxundefined`。
- **`desktop_type` 打完把前台还给你**：抢了别人的前台之后会还回去。
- **测试**：新增 `tests/unit.mjs`（纯逻辑：按键解析、锁屏判断、文字定位、PNG 编码）与 `tests/smoke.mjs`（假 host 启动 + 19 个工具的 schema/渲染检查），`npm test` 一条命令跑完。


## 0.5.5 — 2026-10-28

- **锁屏判断更稳**：不再单靠 `WTSQuerySessionInformation` 的标志位（微软文档写 0=锁定、1=未锁，但个别机器实测相反）。现在把「WTS 标志」和「LogonUI / LockApp 进程快照」两个信号互相印证才判定锁定，任一方向误判的概率都更低：标志说锁定但没有任何锁屏进程、且能读到进程表时，不再拦截。

## 0.5.4 — 2026-10-28

让它做的事看得见、停得下、查得到。

### 新增

- **屏幕状态条**：真正操作时屏幕底部出现「DSH 正在操作这台电脑」。进程内 GDI 自绘（koffi 直调 user32/gdi32 + layered window），不装任何依赖、不抢焦点、鼠标穿透、1.4 秒无动作自动收起；创建失败不影响功能，只是没有屏幕提示。
- **`desktop_log` 工具**：每次点击 / 输入 / 按键 / 序列执行都记一条（时间、工具、窗口、坐标、结果、是否重试），`{"limit":30}` 回看，`{"clear":true}` 归档成 `actions.jsonl.1` 后清空。文件 `%TEMP%/dsh-sidecar/actions.jsonl`，最多 500 行。
- **技能说明** `skills/desktop-sidecar/SKILL.md`：把「先看后动、能用 UIA 就别用坐标、多步走 desktop_sequence」写成给模型的固定套路。

### 改进

- **Esc 中止**：`desktop_sequence` / `desktop_course` 同时把状态条捕获的 Esc 边沿和 `GetAsyncKeyState` 当取消信号，当前步骤做完即停（`cancelled:true` / `stoppedByUser:true`）。
- **点空了自动重新定位**：`desktop_click{text}` 点完像素没变时，会重新 OCR 一次，位置真变了就按新坐标再点，返回 `relocated:true`。
- **安全桌面拦截**：锁屏 / UAC 提权确认 / 切换用户界面一律拒绝模拟输入，返回 `refused: secure desktop`。
  三条信号互证：`WTSQuerySessionInformation` 的会话锁定标志、`LogonUI.exe` / `LockApp.exe` 进程快照、输入桌面名是否为 Default。
  覆盖 `desktop_click` / `desktop_type` / `desktop_key` / `desktop_invoke` / `desktop_sequence` / `desktop_course`（**不带 window 参数时同样拦截**）。
- **`desktop_doctor` 锁屏感知**：锁屏时把 OCR / 前台锁两项标为「跳过」而不是失败，`secure-desktop` 一项直接说明当前状态，避免误报机器坏了。
- **状态条进度**：`desktop_sequence` 显示「第 N 步 · click」与 `n/total`；`desktop_course` 显示「盯课 n/总数」。
- **`desktop_doctor`** 增加 `hud` / `action-log` / `secure-desktop` 三项自检。

### 文档

- README 增加状态条、发微信、读网课三张图，补「操作时的屏幕提示与日志」一节与英文小节。

## 0.5.3 — 2026-10-28

修社区反馈的两个问题（issue #3 / #4）。

### 修：`desktop_invoke` 可能点到「另一个名字相似的控件」（#3）

以前按子串匹配、取第一个命中，于是 `text:"内存"` 有可能命中父容器 `内存添加`：界面上什么都没发生、`done` 却可能是 true。

现在：

- 名字**完全一致**的控件优先；
- 子串命中多个时**一个都不点**，返回 `ambiguous:true` 和 `candidates`（名字 / 角色 / 矩形 / 能力），让你改用精确名字或加 `role`；
- 新增 `match: auto | exact | substring` 与 `role` 参数；
- 唯一可执行的情况下才动作，并在返回里带 `matchKind`（exact / substring）与 `rect`，方便事后核对点到的是谁。

### 新增：按名字点击 `desktop_click{name, role}`（#3）

`control:N` 的编号会随界面变化失效。现在可以直接写控件名，点击那一刻才定位：

```
desktop_click { window: "记事本", name: "保存", role: "Button" }
```

`desktop_sequence` 的 click 步骤同样支持 `{name, role, match}`。

### 修：`+` 键无法按（#4）

`desktop_key{"key":"+"}` 以前抛 `unknown key: +`，因为按 `+` 拆分组合键时把加号本身拆没了。现在：

- `"+"`、`"-"`、`"ctrl++"`、`"ctrl+shift++"` 都能正确解析；
- `+` 会自动补 Shift（美式/中文键位上 `+` 是 Shift+`=`），打出的是 `+` 而不是 `=`；
- 顺带支持 `f1`~`f24`、`plus` / `minus` / `comma` 等别名。

### 修：`desktop_doctor` 的 DPI 误报（#4）

以前只看 setter 的返回值。宿主进程如果已经设过 DPI 感知，再调 setter 会返回 false / E_ACCESSDENIED，于是被误判成「未启用 DPI 感知」。

现在改为查询进程真实级别（`GetProcessDpiAwareness`，回退 `GetThreadDpiAwarenessContext`），返回 `level: 0/1/2`；setter 失败但进程本身已感知时会在 detail 里注明，不再算失败。

### 文档

- `desktop_capture` 的 `x/y/width/height` 明确为「仅区域截图生效」，给了 `window` 就按整窗截。
- **`desktop_course` 不再猜窗口**：它会在页面上真的点「播放 / 下一节」，所以现在必须点名窗口；只有 `dryRun:true`（只观察）才允许顺手取前台的浏览器。不点名时直接拒绝并说明，不会再对着聊天窗口盯 20 秒。
- **`desktop_type` 不再接受空文本**：以前 `text` 缺失时会把字符串 "undefined" 真打进当前焦点窗口。现在空文本直接报错。
- **`desktop_wait` 先校验 kind**：`kind` 写错时直接说「只能是 window | text | change | idle」，而不是先抱怨缺 window。
- **屏幕外坐标说清楚**：`desktop_click{x:99999}` 现在报「这个点不在屏幕里（屏幕 1920x1080）」，不再说成控件滚出可视区。
- **未知协议不再当成路径**：`desktop_launch{target:'bad://x'}` 报「不认识的协议，什么都没启动」，而不是 "not found"。
- **`maxSteps` 小于 1 直接报错**：以前 `maxSteps:0` 会被当成默认 24 继续跑。
