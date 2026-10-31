import type { ReactNode } from "react";
import { HelpCircle, ShieldCheck, Sparkles, X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { dt } from "./desktopI18n";

const guideSections = [
  {
    title: "快速开始",
    icon: Sparkles,
    items: [
      "登录元衡账号，等待模型和令牌分组同步完成。",
      "进入工作台选择工具，点击配置，客户端会自动写入所需设置。",
      "首次配置后按提示重新打开对应的 AI 工具。",
    ],
  },
  {
    title: "日常使用",
    icon: HelpCircle,
    items: [
      "在工作台直接切换模型、令牌分组和推理等级。",
      "图片与视频位于声音克隆下方：选择模型、填写描述后生成；视频未完成时在作品记录继续查询，勿重复提交。",
      "Codex 支持在元衡中转与 OpenAI 官方账号之间切换。",
      "模型切换前会进行兼容性预检，避免配置后才发现协议或模型不匹配。",
    ],
  },
  {
    title: "遇到问题",
    icon: ShieldCheck,
    items: [
      "先点击重新检测，确认工具路径、账号连接和本地路由状态。",
      "配置未生效时，完全退出并重新打开对应工具。",
      "仍然失败时，查看诊断信息，并提供工具、模型、错误提示和发生时间。",
    ],
  },
] as const;

const faq = [
  [
    "为什么配置后还不能用？",
    "多数情况是工具尚未重新打开，或当前模型/分组刚刚发生变化。",
  ],
  [
    "切换官方账号会删除元衡配置吗？",
    "不会。两种模式独立保存，切回元衡后会恢复上次模型和分组。",
  ],
  [
    "第三方 Skill 可以直接安装吗？",
    "可以检索，但社区 Skill 可能未经验证，请确认来源后再安装。",
  ],
] as const;

interface HelpDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

export function HelpDrawer({ open, onOpenChange, children }: HelpDrawerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        zIndex="top"
        closeOnInteractOutside
        variant="fullscreen"
        overlayClassName="bg-black/30 backdrop-blur-[2px]"
        className="left-auto w-[460px] max-w-[92vw] overflow-hidden border-l shadow-2xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right"
      >
        <div className="flex shrink-0 items-start gap-3 border-b px-5 py-5">
          <div className="min-w-0 flex-1">
            <DialogTitle className="font-display text-lg font-semibold">
              {dt("使用说明")}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs leading-5">
              {dt("安装、配置、模型切换和常见问题都可以在这里快速查看。")}
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <button
              type="button"
              aria-label={dt("关闭帮助")}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" />
            </button>
          </DialogClose>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          <p className="mb-4 text-xs leading-5 text-muted-foreground">
            {dt("使用说明随客户端更新，可离线查看。")}
          </p>
          <div className="grid gap-3">
            {guideSections.map(({ title, icon: Icon, items }) => (
              <section
                key={title}
                className="rounded-2xl border bg-card p-4 shadow-sm"
              >
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="h-4 w-4" />
                  </span>
                  <h2 className="font-display text-sm font-semibold">
                    {dt(title)}
                  </h2>
                </div>
                <ol className="mt-3 space-y-2.5">
                  {items.map((item, index) => (
                    <li
                      key={item}
                      className="flex gap-2 text-xs leading-5 text-muted-foreground"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-foreground">
                        {index + 1}
                      </span>
                      <span>{dt(item)}</span>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>

          <section className="mt-3 rounded-2xl border bg-card p-4 shadow-sm">
            <h2 className="font-display text-sm font-semibold">
              {dt("常见问题")}
            </h2>
            <div className="mt-3 divide-y">
              {faq.map(([question, answer]) => (
                <details
                  key={question}
                  className="group py-2.5 first:pt-0 last:pb-0"
                >
                  <summary className="cursor-pointer list-none text-xs font-semibold marker:hidden">
                    <span className="mr-2 text-primary">＋</span>
                    {dt(question)}
                  </summary>
                  <p className="mt-1.5 pl-5 text-xs leading-5 text-muted-foreground">
                    {dt(answer)}
                  </p>
                </details>
              ))}
            </div>
          </section>

          <p className="mt-4 text-center text-[11px] text-muted-foreground">
            {dt("请勿分享账号密码、API 密钥或未经授权的声音与内容。")}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
