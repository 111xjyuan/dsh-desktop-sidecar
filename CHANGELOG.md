# 更新日志

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
