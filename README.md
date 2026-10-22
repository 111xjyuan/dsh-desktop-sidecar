# dsh-desktop-sidecar

给 DeepSeek Harness 装上「手」：原生 Windows 桌面控制。不依赖 Python、不下载驱动、不弹窗口。

在任意 Windows 10/11 应用里**看屏幕、读文字、点按钮、打字、按快捷键**——包括微信、Office、浏览器、网课播放器这些没有自动化接口的软件。

```
desktop_windows → 现在有哪些窗口
desktop_tree    → 这个窗口有哪些控件（UIA，含名字/角色/能力）
desktop_invoke  → 直接触发控件（不移动鼠标、不需要窗口在前台）
desktop_read    → 窗口里写了什么（离线 OCR，带坐标）
desktop_capture → 截图（可直接喂给模型看）
desktop_click   → 按文字或坐标点击（点击后像素校验）
desktop_type    → 输入中文（剪贴板 + 真 Ctrl+V，稳）
desktop_key     → 按键 / 组合键
desktop_course  → 网课自动播放（帧差判播放 + 自动下一节）
desktop_doctor  → 环境自检，出问题先跑这个
```

## 3 分钟上手

1. 安装，任选一种：

   ```
   # A. npm（已发布，推荐）
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

## 两条路线（很重要）

| 应用类型 | 识别方式 | 说明 |
|---|---|---|
| 记事本、Office、资源管理器、设置、WinUI 应用 | **UIA 控件树** | `desktop_tree` 拿到按钮/菜单的名字与 `Invoke` 能力，`desktop_invoke` 直接触发——不移动鼠标、不需要前台，最稳也最省 token |
| 微信、VS Code、Discord、Electron/Qt 自绘界面 | **OCR + 坐标点击** | 这些应用不实现 UIA，`desktop_tree` 会返回空并自动附一段 OCR 摘要；用 `desktop_read` 找字、`desktop_click` 的 `text` 参数按字点击 |

经验法则：**能用 `desktop_invoke` 就别用 `desktop_click`；能按文字点就别按坐标点。**

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

## 许可

MIT
