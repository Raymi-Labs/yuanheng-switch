# Agent Note: 正式签名候选仅保留构建产物

Status: implemented

## Problem

本地候选签名身份与正式安装不同，升级后旧钥匙串访问被阻断，不能代替正式签名包的登录继承验收。现有Desktop Release手动入口会创建草稿Release，缺少明确的仅构建候选模式。

## Decision

复用release.yml的三平台构建、Apple签名/公证、更新签名及产物校验，新增workflow_dispatch布尔输入candidate_only，默认false保留原手动草稿行为。显式true时只执行validate/build及Actions产物上传，跳过唯一拥有contents:write的finalize任务，其下游镜像自然跳过。不创建标签/Release/latest，不调用生产分发。不把编译产物当作运行验收成功。

## Existing note review

- [原生候选回归](../../proposed/testing/2026-10-29-native-candidate-regression.md)部分重叠：本篇提供签名构建入口，不改变真实请求和系统权限缺口。
- [已有标签发布](../../implemented/bug-fix/2026-10-13-release-existing-tag-target.md)不变：正式标签仍走原发布流程。
- 现有recover-context只接受push标签run，不能把手动候选run作为正式发布恢复来源。

## Alternatives considered

- 本机导入正式证书：可签名，但需要将发布秘密引入个人设备，不采用。
- 复用现有手动草稿入口：已有完整签名链，但会增加草稿Release和manifest；候选测试采用显式无发布选项。
- 新建独立签名工作流：隔离直观，但复制签名、产物校验和构建配置容易漂移；复用并限制现有finalize入口。

## Verification

默认手动和标签发布保持原条件，候选手动运行跳过finalize/delivery；签名公证检查、三平台完整性、原提交checkout和产物保留不变。测试核对实际workflow的布尔输入、finalize条件、唯一写权限和delivery依赖，并验证全构建成功的手动run仍被恢复入口拒绝；Ruby YAML解析通过。合入伙伴v0.1.116后完整前端162文件1144项、typecheck、renderer、locked GUI/Core check及Rust选路15项通过，feature契约3项和发布版本检查通过。外部运行与签名产物结果另行记录，本地通过不代表已经生成候选安装包。

## Consequences

候选仍消耗三平台CI资源，产物仅保存7天；公开仓库的Actions产物不作为秘密存储。提交前排除个人VM交接记录和凭据。版本沿用伙伴0.1.116，候选身份以run与提交SHA区分，不覆盖该正式版附件、不触发用户自动更新。
