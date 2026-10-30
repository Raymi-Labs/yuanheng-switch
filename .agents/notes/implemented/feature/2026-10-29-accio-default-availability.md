# Agent Note: Accio 全平台默认展示与构建启用

Status: implemented

## Problem

用户要求所有版本开启Accio。此前普通开发构建和Windows/Intel发布隐藏入口，预览与Apple Silicon安装包不一致。源码检查确认macOS有通用启动实现，Windows的发现、预检、启动仍未实现；取消编译限制不能创造这些能力。

## Decision

所有前端默认显示Accio并参加安装目录查询，Cargo默认启用原实验feature；GUI及Core构建脚本和三平台发布矩阵保持一致。不再以旧环境变量隐藏入口。保留已有平台能力检查、签名和版本约束。Windows可看到入口及“不支持”的真实状态，不向用户呈现可用的配置/启动按钮。Intel启用既有macOS路径，但明确未完成真机验收，不宣称已可用。既有Apple Silicon流程不变。

## Existing note review

- [首版实验范围](2026-10-27-agent-experimental-release.md)部分替代：默认隐藏/限制发布架构由本篇改变，真实功能验收证据仍保留。
- [主模型桥接](../../proposed/feature/2026-10-18-accio-primary-model-bridge.md)部分重叠：本篇不补写Windows启动或官方电商云端工具。

## Alternatives considered

- 只开启预览变量：最小改动，但不满足用户要求所有版本都显示，且以后仍会出现预览与安装包不一致。
- 删除全部平台检查：能让按钮看似可点，但Windows启动函数未实现，会产生虚假的支持状态，不采用。
- 默认编入并展示、根据实际后端能力控制操作：实现用户可见性要求，同时保留真实兼容性限制；需要进一步开发才能兑现Windows可用。

## Verification

默认及旧环境变量均显示Accio；构建契约3项通过，核对Cargo默认feature、GUI/Core脚本及三平台发布矩阵一致。增加不支持状态在卡片和工作台可见且不调用启动的回归。全量162文件/1134项初跑有3项沿用旧条件数量失败，更新后对应useModelSwitchCenter的24项全部通过，其余161文件已通过；工具网格16项通过。typecheck和renderer构建通过，默认预览已生成Accio卡片。后续从旧target记录找回Rust 1.95工具链，当前源码GUI/Core locked check及build通过，Accio57项/TRAE8项Rust测试通过，App候选打包和Core隔离生命周期通过。专用VM保留业务配置、候选Core受控启动Accio返回200；完整GUI流程受钥匙串恢复和系统权限弹窗阻塞，未发真实推理请求。见[候选回归记录](../../proposed/testing/2026-10-29-native-candidate-regression.md)。未发布安装包，不宣称Intel/Windows真机验收。

## Consequences

开启不等于原生验收，Windows完整接入仍未完成；Intel实际运行待真机验证。默认构建会包含更多现有代码。显式说明缺口，不修改官方应用、不发送真实密钥或付费请求。
