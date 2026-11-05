# GitHub / Google 浏览器登录（待服务端配套上线）

客户端提供GitHub、Google入口，调用网站能力接口确认提供商已启用，再打开系统浏览器的授权页。未登录网站时，通过网站现有登录入口完成登录；用户核对当前元衡账号和客户端显示的8位代码后批准。客户端每3秒查询，授权5分钟过期。密码入口保留。

浏览器链接只携带随机请求标识，不携带Cookie、API Key或verifier。原生进程保管verifier，服务器保存S256 challenge及一次性状态。批准后给客户端签发独立session Cookie，使用原有系统凭据存储。不会复制浏览器Cookie、创建新的模型分组令牌或自动改工具配置。

网站依赖：`GET /api/desktop-auth/capabilities`、`POST /start`、`GET /info`、`POST /approve`和`POST /exchange`（短路径均在相同`/api/desktop-auth`前缀），以及`/desktop-login`网页和DesktopLoginGrant数据库迁移。用户选择客户端先发布，Meta由用户随后部署；部署前若返回404、能力版本不符或提供商禁用，客户端明确报未就绪，不自动切换供应商或索要第三方密码。

批准页仅接受浏览器session、固定站点Origin和会话绑定CSRF，并核对页面显示的user_id与实际session一致；禁用用户、过期请求、错误verifier、重复批准或兑换拒绝。原子条件更新用于多实例单次消费，SQLite测试不能替代生产数据库迁移演练。

取消后本机丢弃verifier，迟到结果不能保存；服务端短期记录在过期后清理。兑换已消费但响应丢失时重新发起，不自动复用已消费授权。用户在浏览器只批准自己发起的请求，授权授予完整元衡登录会话，不是只读模型权限。

本地验证：客户端1282项前端测试、5项原生测试、Clippy与renderer构建；网站Vite构建、模型/控制器的授权竞争、CSRF、账号切换、重复兑换和禁用用户测试通过。MySQL/PostgreSQL由Meta专用CI检查；真实GitHub/Google浏览器交互及生产部署由用户部署后确认，不能将本地通过当作线上可用。
