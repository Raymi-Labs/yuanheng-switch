import { useTranslation } from "react-i18next";
import { ArrowRightLeft, BellOff } from "lucide-react";
import { ToggleRow } from "@/components/ui/toggle-row";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import {
  useSaveSessionSyncPrefsMutation,
  useSessionSyncPrefsQuery,
} from "@/lib/query/sessionSync";
import { extractErrorMessage } from "@/utils/errorUtils";

/** 设置 → 桌面体验：启动前同步询问总开关，以及清空"不再提醒"。 */
export function SessionSyncSettings() {
  const { t } = useTranslation();
  const { data: prefs } = useSessionSyncPrefsQuery();
  const save = useSaveSessionSyncPrefsMutation();

  const update = async (next: NonNullable<typeof prefs>) => {
    try {
      await save.mutateAsync(next);
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  const mutedCount = prefs?.muted.length ?? 0;

  return (
    <section className="space-y-3">
      <ToggleRow
        icon={<ArrowRightLeft className="h-4 w-4 text-sky-500" />}
        title={t("sessionSync.settingTitle", {
          defaultValue: "启动时帮我同步各客户端的聊天记录",
        })}
        description={t("sessionSync.settingDescription", {
          defaultValue:
            "启动 Claude Code、Codex、Gemini CLI、Grok Build 或 OpenCode 时，如果其他客户端里有这个项目的聊天还没带过来，会先问你一次。",
        })}
        checked={prefs?.promptOnLaunch ?? true}
        disabled={!prefs || save.isPending}
        onCheckedChange={(value) =>
          prefs && void update({ ...prefs, promptOnLaunch: value })
        }
      />
      {mutedCount > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card/50 px-4 py-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <BellOff className="h-3.5 w-3.5" />
            {t("sessionSync.mutedCount", {
              defaultValue: "有 {{count}} 个项目设为不再提醒",
              count: mutedCount,
            })}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={save.isPending}
            onClick={() => prefs && void update({ ...prefs, muted: [] })}
          >
            {t("sessionSync.clearMuted", { defaultValue: "恢复提醒" })}
          </Button>
        </div>
      )}
    </section>
  );
}
