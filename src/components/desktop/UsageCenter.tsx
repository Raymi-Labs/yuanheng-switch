import { useState } from "react";
import {
  Activity,
  CreditCard,
  History,
  LoaderCircle,
  WalletCards,
} from "lucide-react";
import type { AppId } from "@/lib/api";
import { APP_ICON_MAP } from "@/config/appConfig";
import { UsageDashboard } from "@/components/usage/UsageDashboard";
import { SessionManagerPage } from "@/components/sessions/SessionManagerPage";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useYuanhengConnection } from "@/lib/query/yuanheng";
import { useYuanhengTopup } from "@/hooks/useYuanhengTopup";
import { PageHeader } from "./PageHeader";
import { dt } from "./desktopI18n";

interface UsageCenterProps {
  activeApp: AppId;
  onSetActiveApp: (app: AppId) => void;
  refreshIntervalMs?: number;
  onRefreshIntervalChange?: (next: number) => Promise<boolean> | boolean | void;
}

const SESSION_APPS: AppId[] = [
  "claude",
  "codex",
  "gemini",
  "grokbuild",
  "opencode",
  "openclaw",
  "hermes",
];

export function UsageCenter({
  activeApp,
  onSetActiveApp,
  refreshIntervalMs,
  onRefreshIntervalChange,
}: UsageCenterProps) {
  const [tab, setTab] = useState("usage");
  const { data: connection } = useYuanhengConnection();
  const { isOpening, openTopup } = useYuanhengTopup();
  const sessionApp = SESSION_APPS.includes(activeApp) ? activeApp : "claude";
  const balance = connection?.account?.remainingUsd;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden px-7 pt-6">
      <div className="mx-auto w-full max-w-[1120px]">
        <PageHeader
          eyebrow={dt("会话与用量")}
          title={dt("会话与用量")}
          description={dt("本地请求、会话历史和元衡余额集中在同一处查看。")}
          actions={
            connection?.connected ? (
              <div className="flex h-9 items-center gap-2 rounded-lg border bg-card pl-3 pr-1 text-[11px]">
                <WalletCards className="h-3.5 w-3.5 text-primary" />
                {dt("元衡余额")}
                <strong>
                  {typeof balance === "number" && Number.isFinite(balance)
                    ? `$${balance.toFixed(2)}`
                    : dt("余额暂未同步")}
                </strong>
                <button
                  type="button"
                  onClick={() => void openTopup()}
                  disabled={isOpening}
                  className="ml-1 inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-wait disabled:opacity-70"
                >
                  {isOpening ? (
                    <LoaderCircle className="h-3 w-3 animate-spin" />
                  ) : (
                    <CreditCard className="h-3 w-3" />
                  )}
                  {dt("充值")}
                </button>
              </div>
            ) : undefined
          }
        />
      </div>

      <Tabs
        value={tab}
        onValueChange={setTab}
        className="mx-auto flex min-h-0 w-full max-w-[1120px] flex-1 flex-col"
      >
        <div className="mb-4 flex shrink-0 items-center justify-between gap-4">
          <TabsList className="h-9">
            <TabsTrigger value="usage" className="gap-1.5 text-[12px]">
              <Activity className="h-3.5 w-3.5" /> {dt("用量统计")}
            </TabsTrigger>
            <TabsTrigger value="sessions" className="gap-1.5 text-[12px]">
              <History className="h-3.5 w-3.5" /> {dt("会话记录")}
            </TabsTrigger>
          </TabsList>
          {tab === "sessions" && (
            <Select
              value={sessionApp}
              onValueChange={(value) => onSetActiveApp(value as AppId)}
            >
              <SelectTrigger className="h-9 w-40 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SESSION_APPS.map((app) => (
                  <SelectItem key={app} value={app}>
                    {APP_ICON_MAP[app].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <TabsContent
          value="usage"
          className="mt-0 min-h-0 flex-1 overflow-y-auto pb-8"
        >
          <UsageDashboard
            refreshIntervalMs={refreshIntervalMs}
            onRefreshIntervalChange={onRefreshIntervalChange}
          />
        </TabsContent>
        <TabsContent
          value="sessions"
          className="mt-0 min-h-0 flex-1 overflow-hidden rounded-2xl border bg-card"
        >
          <SessionManagerPage key={sessionApp} appId={sessionApp} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
