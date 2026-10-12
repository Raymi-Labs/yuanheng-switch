# macOS Developer ID 签名与公证发布

元衡通过官网和 GitHub Release 分发 DMG，分别支持 Apple 芯片与 Intel Mac，最低系统版本仍是 macOS 12。应用标识保持 `com.nanashiwang.yuanhengswitch`，已有用户的数据目录及自动更新公钥不变。

## 凭据配置

开发者会员须已生效。申请 **Developer ID Application** 证书并选择 G2 中间证书；保存对应私钥，导出带密码的 `.p12`。不使用 iOS Distribution、Apple Development 或 Mac App Store 的证书。

在此仓库的 GitHub Actions Secrets 配置以下名称：

| 名称 | 内容 |
| --- | --- |
| `APPLE_CERTIFICATE` | 包含证书和对应私钥的 `.p12`，Base64 编码 |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` 导出密码 |
| `APPLE_SIGNING_IDENTITY` | 完整的 `Developer ID Application: … (TEAM_ID)` 名称 |
| `APPLE_TEAM_ID` | 证书所属开发者团队 ID |
| `APPLE_ID` | 用于公证的 Apple 账号邮箱 |
| `APPLE_PASSWORD` | 该账号生成的 App 专用密码，不是 Apple 账号登录密码 |

私钥、`.p12`、导出密码和 App 专用密码保存在仓库外，不提交 Git、不写进公告或日志。可通过交互式 `gh secret set NAME --repo nanashiwang/yuanheng-switch` 设置值，避免把秘密直接放进命令行或聊天。

Tauri 更新密钥 `TAURI_SIGNING_PRIVATE_KEY` 及其密码继续沿用；自动更新 `.sig` 验证下载字节，Developer ID 与 Apple 公证负责 macOS 分发信任，两个链路均须验证。

## Apple 服务瞬时失败与票据装订

[Apple 工具重试脚本](../../scripts/apple-release-tools.py) 只在 macOS 发行 job 的临时 PATH 中包装 `xcrun` 和 `codesign`，调用的仍是 `/usr/bin` 原生工具。公证提交及其他命令直接转交，参数、标准输入和输出保持原样，不记录公证凭据。

票据装订最多尝试 5 次，间隔为 15、30、60、120 秒；每次原生命令最长 120 秒。装订返回成功后立即执行 `stapler validate`，验证通过才记录当前 app 的成功凭据并交回 Tauri 继续打包。签名仅对明确的 `timestamp service is not available` 重试，最多 3 次，间隔 15、30 秒；证书、身份和权限等错误直接失败。

当前 Tauri CLI 会忽略装订命令的退出码和输出，因此脚本另存失败标记与已验证 app 路径。打包后独立检查这些记录，再进入原有最终产物验证；Tauri 吞掉装订失败或未调用包装器都不能进入产物上传。诊断在构建成功或失败后输出，已知凭据值会脱敏。最终的 app、更新归档和 DMG 校验仍直接调用原生工具；其中 stapler validate 仅对临时主机/服务错误（退出码 68、75）最多尝试 3 次，等待 15、30 秒。缺失/无效票据、签名或 Gatekeeper 拒绝直接失败，网络重试耗尽也停止发布。

Apple 返回 `Accepted` 只确认公证通过，尚需验证实际包内的票据；缺票据时不要删除校验或仅修复构建目录而继续分发旧归档。失败后的重新构建会复用可用的 Rust 缓存，重新完成签名、票据验证及整套打包。已创建标签保持原提交，新流程通过新版本发布。

本地回归：`python3 scripts/test_apple_release_tools.py`，覆盖暂时失败恢复、装订假成功、重试耗尽、缺失/错误构建记录、时间戳失败、其他命令透传和凭据脱敏。它不代替带真实 Apple 凭据的发行构建。

## 构建与验证

沿用 [Desktop Release](../../.github/workflows/release.yml) 和[集中发布](../release-announcements.md)。macOS 发行构建必须具有全部 Apple 凭据，缺失时失败，不再生成未签名发行包。Tauri 执行证书导入、加固运行时签名、公证和票据装订，然后产生自动更新归档与签名。

[验证脚本](../../scripts/verify-macos-release.py) 在上传工作流产物前检查：

- 原始 app、自动更新归档中的 app、只读挂载 DMG 中的 app，分别核对标识和版本。
- 主程序与 `yuanheng-core` 的有效 Developer ID 签名、相同团队、加固运行时、安全时间戳与目标架构。
- `stapler validate` 验证 app 的公证票据，`spctl --assess` 确认 Gatekeeper 接受。

验证不会启动应用或发起模型请求。DMG 验证针对实际分发的内部 app，不把磁盘映像自身签名与 app 公证混为一谈。所有平台成功后才由原有集中任务核对摘要和更新签名、公开 Release，再执行镜像上传。

本机离线回归：`python3 scripts/test_verify_macos_release.py`。实际签名和公证还需有凭据的 macOS 构建，不由模拟测试或 Secret 名称存在代替。首次公证可能需要更长时间；排错使用 Apple 返回的提交状态和日志，不通过关闭 Gatekeeper 或移除 quarantine 规避验收。

构建停在 `Notarizing` 或被取消时，运行 [Apple Notarization Status](../../.github/workflows/apple-notarization-status.yml) 手动工作流，或执行 `gh workflow run apple-notarization-status.yml`。该任务复用现有三项公证凭据，只读取最近的元衡提交编号、时间和状态；不编译、不提交新的公证请求、不发布安装包。`In Progress` 表示仍在处理，`Accepted` 才表示 Apple 接受；空列表或 `Notarizing` 日志本身不能证明上传已完成。不要把 CI 超时等同于 Apple 拒绝。

## 发布验收边界

只有两个 macOS 构建都通过真实公证和最终产物检查，才能称该版本已签名并公证。已发布的旧版安装包不就地覆盖，改用新的版本号生成整套安装包、更新签名和清单。其他用户设备上的首次安装仍应验证下载、拖入“应用程序”、首次打开及 Core 启动；首次正常的系统确认对话框不等于签名错误。

参考：[Apple Developer ID](https://developer.apple.com/developer-id/)、[Tauri macOS 签名](https://v2.tauri.app/distribute/sign/macos/)。

## 更新后的钥匙串访问

旧版 ad-hoc 签名不提供跨版本稳定身份。正式版必须始终使用相同 Developer ID 团队和应用标识；已有旧条目的访问控制不会被签名流程自动改写。v0.1.68 起启动、刷新和第三方订阅查询禁止隐式钥匙串弹窗。元衡旧登录信息被系统拦截时，在登录页主动点击“恢复本机登录”才请求授权，仅涉及本应用固定 service 下的登录条目。取消保留原值；客户端不索取 macOS 密码，也不放宽条目 ACL。

已授权读取的值仅在本进程中复用，退出/删除和写入同步处理缓存；SQLite 迁移仍直接回读系统凭据库后才删除旧值。临时钥匙串回归测试使用独立文件和模拟凭据，覆盖锁定后立即失败、交互状态恢复，不读取用户真实凭据。首次从未签名版恢复可能需要一次性授权，稳定签名不会绕过旧 ACL。
