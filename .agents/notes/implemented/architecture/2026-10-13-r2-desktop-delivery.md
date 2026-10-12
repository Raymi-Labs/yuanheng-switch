# Agent Note: 桌面安装包使用 R2 与 CDN 分发

Status: implemented

## Problem

R2 实测的 23 MB 包在现有 Mac 代理/TUN 网络约 3–7 秒完成，原入口单独请求仅约 62 KB/s。现有发布只同步到平台本地目录；新 R2 域名只有测试文件，不能直接宣称后续版本自动分发。

## Existing capabilities and impact

复用 Desktop Release 的三平台产物、单一签名清单、现有镜像上传和防降级顺序。官网下载和旧客户端地址由平台 ServerAddress 派生；客户端的固定地址识别、续传及签名验证由 `update_download` 拥有。活跃笔记检索：[原下载故障笔记](../bug-fix/2026-10-12-update-download-failover.md)部分重叠，保留择源和缓存修复结论；本篇只拥有新增 R2 发布链路与兼容跳转。帮助抽屉和 v0.1.77 发布由另一聊天负责，本次不改其版本/公告/标签。

## Decision

使用现有 `yuanheng-desktop-downloads` 标准桶和 `download.meta-api.vip` 自定义域。正常发布、镜像重试与收尾恢复都复用同一分发工作流，先校验已发布 GitHub Release 的完整资产、SHA-256 与清单/签名一致性，按不可变版本路径同步全部安装包及签名，公开整包校验通过后才执行原平台镜像和 latest 发布。R2 凭据只允许读写该桶，通过 GitHub Actions Secrets 注入；代码与日志不保存密钥。

新客户端识别精确 R2/原镜像/GitHub 官方路径，实际使用 R2 与 GitHub 择源，保留原签名和 Range 协议。旧下载路径在源站 Nginx 返回禁止缓存的临时跳转，文件内容走 R2；先回填仍受该跳转覆盖的历史版本。平台镜像探测使用显式 `origin=1` 读取本地源文件，不能因跟随 R2 跳转而错误跳过本地上传。清单、上传、API/SSE 和全站 ServerAddress 不迁移。

## Alternatives considered

- 直接改全站 ServerAddress：实现短，但会改变回调、认证与 API 地址，范围不成立。
- 增加平台独立下载域设置并部署 newapi：长期合理，但需要跨仓库接口/UI/服务发布；已有版本路径和 Nginx 可兼容本次迁移，先复用。
- 仅通过 Nginx 反代 R2：源站及入口仍传输全部字节，保留已证实的吞吐瓶颈。
- 永久跳转或只保留 R2：回滚困难且不能覆盖各地线路差异，保留临时跳转和 GitHub 备用。

## Verification

离线验证缺少平台/签名、坏摘要、冲突不可变对象、上传/公开校验失败不会发布 latest；同步可重入。客户端固定地址边界、R2 失败切 GitHub、Range 和签名回归通过。当前正式版所有平台包和历史受覆盖包完整校验；生产旧链接 HEAD/GET/206 跳转、origin 本地读取、404、清单及正常 API 验证。12 个历史版本的 96 个文件已在 GitHub Actions 回填并逐一通过 R2 公网摘要校验；源站文件也与 GitHub 摘要一致。v0.1.76 完整分发工作流成功，官网浏览器实际下载的 DMG 摘要一致。

## Consequences

接入代码准备阶段：10 项 R2 同步测试、6 项镜像测试、11 项 Rust 下载回归、actionlint、Rust fmt 通过；真实 v0.1.76 全九个资产通过摘要及清单/签名匹配校验，新下载器真实下载及原公钥验证 4.39 秒，无安装。源站隔离 Nginx 实例的 8 项 GET/HEAD/方法/路径分流检查及完整候选配置 `nginx -t` 通过，生产 Nginx 已备份、校验并平滑重载，当前八个文件的 302/完整下载与五个 Range 校验、404/清单/API 语义全部通过。用户已确认长期桶级对象读写凭据，现已创建并保存到 GitHub Actions 加密 Secrets；历史包回填改由独立 Actions 工作流执行，最多两个版本并行，只写 R2；本机连续 TLS/HTTP2 下载错误后停止本地回填。正式入口已切换；v0.1.77 恢复流程通过 R2 校验、确认新镜像使用 origin=1 后，临时版本排除已解除。

国内直连尚无实测，不能承诺全网速度；Cloudflare/R2 故障依靠 GitHub 备用。原平台仍保存本地包用于镜像发布校验和回滚；本次未额外执行清理；复用平台 latest 发布时，既有保留策略移除了源站 v0.1.61，R2 保留该版。凭据只覆盖下载桶，长期有效；本地临时凭据仅用于首次回填，已移除。
