# Agent Note: 系统浏览器登录元衡账号

Status: implemented

## Problem

网站GitHub/Google用户没有元衡密码时无法进入桌面。原有密码和2FA入口、系统凭据存储可复用，但缺少安全浏览器会话交接。

## Decision

复用网站登录和显式批准页面。原生生成32字节verifier、S256 challenge，五分钟内保存在内存，前端只接收本地attempt id和核对码。固定元衡域名HTTPS请求；系统浏览器只收到随机request id，网页核对账号和代码后批准。每3秒单飞POST查询，兑换独立session Cookie后复用账号同步/安全存储，无工具令牌自动创建。取消、登录方式切换、关闭面板和账号变化均使旧结果不可写回。

服务端需先实现并部署/desktop-auth协议；未部署时显示明确提示，不模拟成功。Google按网站custom_oauth_providers而非OIDC推断，能力接口提供真正启用的GitHub/Google列表。

## Alternatives considered

- WebView登录：体验集中，但Google嵌入限制及密码接触面使其不适合。
- 深链携带Cookie：无需查询，但泄露长期会话且存在协议劫持风险，拒绝。
- 浏览器确认加PKCE绑定的短期设备授权：无需改第三方回调或OAuth密钥，不需本地端口；代价是服务端配套部署和用户核对一次。

## Verification

服务端未部署、禁用提供商、过期、重复查询、取消、迟到响应、密码登录交叉、串账号、拒绝和网络异常均安全失败。URL/日志/前端不携带verifier和Cookie。真实第三方登录需用户操作，离线测试不冒充上线可用。

## Consequences

用户批准即授予完整元衡登录会话，网页必须明确告知。不自动修改第三方账号或真实客户端配置，不操作鼠标。服务端生产部署是单独受保护步骤，未确认上线前不发布可用性承诺。

## Local progress

本地链路已完成，桌面全量1282项前端、5项原生边界测试、Clippy及renderer构建通过；原生直接测试最终持久化阶段的取消、过期、替换请求、已有账号与单次保存，而非仅检查内存字段。网站Vite与Go model/controller测试通过，跨数据库走Meta独立CI。用户明确要求先推送Meta、再合并发布客户端，服务器由用户最后部署；本轮不做生产部署、不进行真实GitHub/Google账号授权，发布提示说明未部署时入口不可用。

第三方提供商按钮是授权发起偏好，不绕过网站现有登录。网站已登录时由用户核对当前元衡账号并显式批准；不声称强制重新认证第三方身份。切换登录/注册面板卸载旧授权流程；成功时保留原系统存储的memory-only警告。Cancel丢弃本机proof，服务端记录最多五分钟失效；不自动重放已消费请求。部署步骤见Meta的docs/installation/desktop-browser-login.md。
