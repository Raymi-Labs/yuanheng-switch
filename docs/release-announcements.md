# 客户端更新公告

## 公司仓库与旧版本兼容

主仓库与新版本发布使用 [Raymi-Labs/yuanheng-switch](https://github.com/Raymi-Labs/yuanheng-switch)。仓库完整转移保留 Git 历史、Release 附件与签名配置；原 `nanashiwang/yuanheng-switch` 地址由 GitHub 重定向，不能重新创建该路径下的同名仓库。

新客户端和新清单直接使用公司仓库；旧清单不重写，下载器与 R2 补发同时识别两个精确仓库路径。应用标识、更新公钥、安装包文件名、平台更新清单、R2 和源站下载路径保持一致。移动端历史 Release 也随仓库保留。公司默认分支要求 PR，工作流依赖使用完整提交 SHA；签名、公证、完整资产及分发门禁继续生效。

官网下载页的桌面与 Android GitHub 备用链接由 `Raymi-Labs/meta-api` 维护，与本仓库同步更新；源码发布与官网部署分别验收。迁移边界见[决策笔记](../.agents/notes/implemented/process/2026-10-27-raymi-repository-migration.md)。

公告只维护一份：`src/data/desktop-release-notes.json`，按版本倒序保留最近两版。
这是用户可读的更新内容，不填提交列表、凭据、个人路径或调试日志。

## 发版步骤

1. 调整应用版本号时，在公告文件最前面加入同版本公告，删除最旧一条。
2. 执行 `pnpm check:release-version`；遗漏公告、版本不匹配或不是两条时会阻止发布。
3. 三平台并行构建，只上传各自的 workflow artifact。统一收尾任务核对完整性后，
   将本版正文写入唯一的 `latest.json.notes`，将两版记录写入 `latest.json.release_notes`，
   并同步 GitHub 发布说明。
4. 分发先上传并校验 R2 安装包，再同步平台本地包，最后发布清单；复用既有签名和平台接口。
5. 客户端工具栏的公告铃铛与「设置 → 关于 → 更新日志」都在内部公告窗口查看。
   更新弹窗展示同一份本版说明，不打开外部网页。

工具栏铃铛在有未读更新公告或平台公告时显示红点；两个分类分别记住本机已读状态，公告内容变化后再次提醒。工作台不再展示常驻横幅。

用户已经更新到最新版也能读取公告；无网络时使用安装包自带或缓存的两条记录。
客户端更新与平台通知分开，平台已有通知的数量和展示逻辑不受两版限制影响。
群公告可以直接复制同一文件中的本版正文，不必再维护第二份内容。

本功能不会读取或上传本机账号、API 密钥、姓名或个人文件。

## 登录失败时更新客户端

从 v0.1.70 开始，登录页顶部始终提供当前版本和“检查更新”，登录加载中、账号密码报错、旧钥匙串不可读、注册和两步验证时均可使用。主动检查不受自动检查关闭、忽略版本或稍后提醒限制；发现更新后使用原有签名验证、下载进度和安装重启流程。检查失败可以重试，或点击“打开下载页”下载正式安装包。

旧版没有该按钮时，可退出客户端，前往[正式发布页](https://github.com/Raymi-Labs/yuanheng-switch/releases/latest)下载对应芯片的 macOS DMG，将应用拖入“应用程序”并选择替换，再从“应用程序”启动并重新登录。Windows 使用新版安装程序覆盖安装。覆盖应用程序不要求删除 `~/.yuanheng-switch/` 或旧钥匙串条目。

如果电脑上存在多个客户端副本，应确认启动的是刚更新的那份；项目构建目录、下载目录和“应用程序”内的版本可能不同。

## 镜像上传中断后的恢复

`Resume Desktop Update Mirror` 工作流接受已发布的版本号（例如 `0.1.51`），只同步该版文件，无需重新构建安装包。正常发布、镜像恢复与收尾恢复共同调用 `Desktop download delivery`，先验证 R2 完整性再镜像，并使用同一并发组串行执行。

脚本先核验 GitHub 清单和三平台签名字段，对镜像上同名且大小一致的文件跳过上传；缺失或大小不符的文件重新上传并检查。全部文件可访问后才提交升级清单，并阻止旧版重试覆盖新版清单。文件大小检查用于判断已上传文件是否完整，客户端仍以原有更新签名验证安装包。

慢速线路下任务上限为 120 分钟，支持重试并输出单文件进度。恢复任务会等待当前镜像完成，勿重复派发多个版本。发布凭据仅在 GitHub Actions secrets 中使用。

本机可执行 `python3 scripts/test_mirror_desktop_update.py` 验证断点恢复逻辑；测试使用模拟工具，不访问网络或真实凭据。

## 并行构建与集中发布

手动运行 `Desktop Release` 时可选择 `candidate_only=true`：复用正式Apple签名、公证及更新签名，构建三个平台并上传Actions产物（保留7天），跳过Release创建、统一发布清单与R2/平台分发。下载对应run的`desktop-<target>`产物用于候选测试，核对receipt提交SHA与文件摘要；候选没有发布给自动更新用户。默认false仍保留原手动草稿流程，正式版本标签行为不变。恢复发布入口只接受正式标签push任务，不接受手动候选任务。

`.github/workflows/release.yml` 的构建矩阵允许三个任务同时运行。构建任务仅有 `contents:read` 权限，不传入 tauri-action 的 Release 标签/ID，并禁用该 action 的 updater JSON 上传。

`scripts/desktop-release.mjs` 提供三个阶段：

1. `collect`：从 tauri-action 输出收集指定 target 的必需安装包和更新签名，统一附件名称；附带版本、提交 SHA、run ID、文件大小和 SHA-256 receipt。
2. `assemble`：只接受当前 run 的三个独立 artifact，核验 target、版本、提交、文件列表和摘要，再一次性生成 `latest.json`，保留原有六个平台键与下载文件名。
3. `publish`：核实远端标签仍指向构建提交；先创建或恢复草稿，上传安装包，再上传唯一清单。核对 GitHub 返回的附件大小、SHA-256 和中文说明后才公开正式版。

缺少目标、签名、版本或摘要不一致时，不会公开部分版本。已公开且内容一致的重试只验证，不重写发布资产；已公开内容不一致则拒绝覆盖。延迟发布旧版本不会把 GitHub 的 Latest 降级。

手动从分支运行仍产生完整的预发布草稿；只有稳定标签触发的正式版才进入原有镜像同步步骤。镜像仍逐文件上传、校验，最后更新平台清单，并保留断点恢复能力。

构建 job 可单独重跑：artifact 名按 target 唯一，覆盖同一 run 的同名产物；不同成功 target 不互相覆盖。统一收尾只在整个矩阵成功后运行，下载时同时校验 workflow artifact 的摘要。artifact 保留 7 天，过期后需重新构建。

发布脚本回归测试：`pnpm test:unit tests/lib/desktopReleasePipeline.test.ts`。修改 workflow 时另用 actionlint 检查。GitHub Release 上传与跨站镜像 PUT 是两个独立阶段，应分别记录耗时。

## 只恢复收尾，不重新编译

当三个构建任务成功、但集中发布步骤失败时，可以从 `main` 运行 `Resume Desktop Release Finalization`，传入原 `Desktop Release` 的 run ID。

恢复任务要求原 run 已结束、版本校验和三平台最新构建尝试全部成功；校验原提交对应的远端标签，从原提交读取版本配置与中文公告，再下载原 run 的独立 artifacts。提交、run、文件摘要校验均沿用正常发布规则，完成后继续原有镜像同步。

恢复执行当前分支修正后的发布脚本，但安装包、声明版本和公告仍绑定原构建提交；不会移动版本标签，也不会把另一次构建的文件混入发布。原始构建未通过时不能使用此入口，artifact 过期时需要重新构建。

GitHub REST 的 `GET /releases/tags/:tag` 不返回草稿。发布脚本先使用 `gh release view --json databaseId` 查找已发布版本或待发布草稿，再按 Release ID 读取完整附件摘要，避免创建草稿后因按标签查询得到 404 而中断。

正式标签已存在并通过远程 SHA 校验时，创建 Release 只传 `--verify-tag`，不再冗余指定 `--target`。GitHub 会对显式 `target_commitish` 与当前默认分支的工作流差异做额外权限检查；标签构建期间 main 新增工作流时，旧 SHA 可能使只有 Contents:write 的 Actions 令牌收到 403。省略该参数不移动已有标签，构建来源仍由标签 SHA、原 run 和产物 receipt 验证。手动分支预发布创建新标签时仍指定构建 SHA。见[GitHub 创建 Release 文档](https://docs.github.com/en/rest/releases/releases#create-a-release)和[决策笔记](../.agents/notes/implemented/bug-fix/2026-10-13-release-existing-tag-target.md)。
