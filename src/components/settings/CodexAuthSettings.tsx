import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { History, KeyRound, Loader2, RotateCcw, Search } from "lucide-react";
import { toast } from "@/lib/toast";
import type { SettingsFormState } from "@/hooks/useSettings";
import { ToggleRow } from "@/components/ui/toggle-row";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { settingsApi } from "@/lib/api";
import {
  normalizeCodexHistoryMigrationTask,
  type CodexHistoryMigrationTask,
} from "@/lib/api/settings";
import { Button } from "@/components/ui/button";
import { extractErrorMessage } from "@/utils/errorUtils";

interface CodexAuthSettingsProps {
  settings: SettingsFormState;
  /** 返回 false（或 resolve 为 false）表示保存失败；其余返回值视为成功 */
  onChange: (
    updates: Partial<SettingsFormState>,
  ) => void | boolean | Promise<void | boolean>;
}

export function CodexAuthSettings({
  settings,
  onChange,
}: CodexAuthSettingsProps) {
  const { t } = useTranslation();
  const [showEnableConfirm, setShowEnableConfirm] = useState(false);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [hasUnifyBackup, setHasUnifyBackup] = useState(false);
  const [migrationTask, setMigrationTask] =
    useState<CodexHistoryMigrationTask | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const task = await settingsApi.getCodexHistoryMigrationStatus();
        if (active) setMigrationTask(normalizeCodexHistoryMigrationTask(task));
      } catch {
        // 历史状态读取失败不阻断其余设置。
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (
        migrationTask?.status === "running" ||
        migrationTask?.status === "paused"
      ) {
        void refresh();
      }
    }, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [migrationTask?.status]);

  const handleUnifyHistoryChange = (checked: boolean) => {
    if (checked) {
      setShowEnableConfirm(true);
      return;
    }
    // 先探测有无迁移备份，决定关闭弹窗是否提供"恢复备份"勾选
    void settingsApi
      .hasCodexUnifyHistoryBackup()
      .catch(() => false)
      .then((hasBackup) => {
        setHasUnifyBackup(hasBackup);
        setShowDisableConfirm(true);
      });
  };

  const handleEnableConfirm = async (migrateExisting: boolean) => {
    setShowEnableConfirm(false);
    const saved = await onChange({
      unifyCodexSessionHistory: true,
      unifyCodexMigrateExisting: false,
    });
    if (saved === false || !migrateExisting) return;
    await runMigrationAction(() => settingsApi.previewCodexHistoryMigration());
  };

  const runMigrationAction = async (
    action: () => Promise<CodexHistoryMigrationTask>,
  ) => {
    setMigrationBusy(true);
    try {
      const task = await action();
      setMigrationTask(normalizeCodexHistoryMigrationTask(task));
      if (task.status === "completed") {
        toast.success(t("settings.codexHistoryMigrationCompleted"));
      } else if (task.status === "rolled_back") {
        toast.success(t("settings.codexHistoryMigrationRolledBack"));
      }
    } catch (error) {
      toast.error(
        extractErrorMessage(error) || t("settings.codexHistoryMigrationFailed"),
      );
    } finally {
      setMigrationBusy(false);
    }
  };

  // 备份探测可能落后于正在后台进行的迁移（刚勾选迁入就立刻关闭时，
  // 备份尚未产出）。只要本轮勾选过"迁入既有会话"，就必须提供恢复入口；
  // 真正有没有账本交给后端 restore 的 skippedReason 判定。
  const showRestoreOption =
    hasUnifyBackup || (settings.unifyCodexMigrateExisting ?? false);

  const handleDisableConfirm = async (restoreBackup: boolean) => {
    setShowDisableConfirm(false);
    const saved = await onChange({
      unifyCodexSessionHistory: false,
      unifyCodexMigrateExisting: false,
    });
    // 关闭保存失败时绝不还原：否则开关仍开着（live 仍统一路由），
    // 已迁移会话却被翻回 openai 桶，历史被拆成两半。
    if (saved === false) return;
    // 不再以探测结果短路：还原命令会在迁移锁上排队，等到迁移落盘后
    // 拿到完整账本；确实无账本时由 skippedReason 提示。
    if (!restoreBackup) return;
    try {
      const result = await settingsApi.restoreCodexUnifiedHistory();
      if (result.skippedReason) {
        // unify_toggle_on：还原排队期间开关被重新开启，后端拒绝还原
        toast.info(
          result.skippedReason === "unify_toggle_on"
            ? t("settings.unifyCodexHistoryRestoreSkippedToggleOn")
            : t("settings.unifyCodexHistoryRestoreNothing"),
        );
        return;
      }
      toast.success(
        t("settings.unifyCodexHistoryRestoreCompleted", {
          files: result.restoredJsonlFiles,
          rows: result.restoredStateRows,
        }),
      );
    } catch (error) {
      console.error("Failed to restore codex unified history:", error);
      toast.error(t("settings.unifyCodexHistoryRestoreFailed"));
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2 pb-2 border-b border-border/40">
        <KeyRound className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-medium">{t("settings.codexAuth")}</h3>
      </div>

      <ToggleRow
        icon={<KeyRound className="h-4 w-4 text-emerald-500" />}
        title={t("settings.preserveCodexOfficialAuthOnSwitch")}
        description={t("settings.preserveCodexOfficialAuthOnSwitchDescription")}
        checked={settings.preserveCodexOfficialAuthOnSwitch ?? false}
        onCheckedChange={(value) =>
          onChange({ preserveCodexOfficialAuthOnSwitch: value })
        }
      />

      <div className="border-t border-border/50 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium">
              {t("settings.codexHistoryMigration")}
            </p>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
              {t("settings.codexHistoryMigrationDescription")}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={migrationBusy || migrationTask?.status === "running"}
            onClick={() =>
              void runMigrationAction(() =>
                settingsApi.previewCodexHistoryMigration(),
              )
            }
          >
            {migrationBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            {t("settings.codexHistoryMigrationDetect")}
          </Button>
        </div>

        {migrationTask && (
          <div className="mt-3 space-y-3 bg-muted/35 px-3 py-3 text-[11px]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">
                {t(
                  `settings.codexHistoryMigrationStatus.${migrationTask.status}`,
                )}
              </span>
              <span className="text-muted-foreground">
                {t("settings.codexHistoryMigrationTarget", {
                  target: migrationTask.targetNamespace,
                })}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground sm:grid-cols-4">
              <span>
                {t("settings.codexHistoryMigrationTotal", {
                  count: migrationTask.preview.totalCount,
                })}
              </span>
              <span>
                {t("settings.codexHistoryMigrationOrdinary", {
                  count: migrationTask.preview.ordinarySessions,
                })}
              </span>
              <span>
                {t("settings.codexHistoryMigrationArchived", {
                  count: migrationTask.preview.archivedSessions,
                })}
              </span>
              <span>
                {t("settings.codexHistoryMigrationActive", {
                  count: migrationTask.preview.activeSessions,
                })}
              </span>
              <span>
                {t("settings.codexHistoryMigrationDatabase", {
                  count: migrationTask.preview.databaseRows,
                })}
              </span>
              <span>
                {t("settings.codexHistoryMigrationProgress", {
                  success: migrationTask.successCount,
                  total: migrationTask.totalCount,
                })}
              </span>
            </div>
            {migrationTask.validation && (
              <p className="text-muted-foreground">
                {migrationTask.validation.totalCountUnchanged &&
                migrationTask.validation.conversationIdsUnchanged &&
                migrationTask.validation.rolloutFilesExist &&
                migrationTask.validation.sqliteIntegrityOk &&
                migrationTask.validation.duplicateSessionIdsUnchanged &&
                migrationTask.validation.orphanStateRowsUnchanged &&
                migrationTask.validation.archiveCountUnchanged
                  ? t("settings.codexHistoryMigrationValidationPassed")
                  : t("settings.codexHistoryMigrationValidationFailed")}
              </p>
            )}
            {migrationTask.error &&
              !migrationTask.error.startsWith("active_sessions_pending") && (
                <p className="break-words text-destructive">
                  {migrationTask.error === "integrity_validation_failed"
                    ? t("settings.codexHistoryMigrationValidationFailed")
                    : migrationTask.error}
                </p>
              )}
            {(migrationTask.pendingFiles ?? []).length > 0 && (
              <p className="text-amber-700 dark:text-amber-300">
                {t("settings.codexHistoryMigrationPending", {
                  count: (migrationTask.pendingFiles ?? []).length,
                })}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {migrationTask.status === "preview" &&
                migrationTask.totalCount > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    disabled={migrationBusy}
                    onClick={() =>
                      void runMigrationAction(() =>
                        settingsApi.startCodexHistoryMigration(),
                      )
                    }
                  >
                    <History className="h-3.5 w-3.5" />
                    {t("settings.codexHistoryMigrationStart")}
                  </Button>
                )}
              {(migrationTask.status === "paused" ||
                migrationTask.status === "failed") && (
                <Button
                  type="button"
                  size="sm"
                  disabled={migrationBusy}
                  onClick={() =>
                    void runMigrationAction(() =>
                      settingsApi.resumeCodexHistoryMigration(),
                    )
                  }
                >
                  <History className="h-3.5 w-3.5" />
                  {t("settings.codexHistoryMigrationResume")}
                </Button>
              )}
              {migrationTask.backupDir &&
                migrationTask.status !== "preview" &&
                migrationTask.status !== "rolled_back" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={
                      migrationBusy || migrationTask.status === "running"
                    }
                    onClick={() =>
                      void runMigrationAction(() =>
                        settingsApi.rollbackCodexHistoryMigration(),
                      )
                    }
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {t("settings.codexHistoryMigrationRollback")}
                  </Button>
                )}
            </div>
          </div>
        )}
      </div>

      <ToggleRow
        icon={<History className="h-4 w-4 text-sky-500" />}
        title={t("settings.unifyCodexSessionHistory")}
        description={t("settings.unifyCodexSessionHistoryDescription")}
        checked={settings.unifyCodexSessionHistory ?? false}
        onCheckedChange={handleUnifyHistoryChange}
      />

      <ConfirmDialog
        isOpen={showEnableConfirm}
        title={t("confirm.unifyCodexHistory.title")}
        message={t("confirm.unifyCodexHistory.message")}
        checkboxLabel={t("confirm.unifyCodexHistory.migrateExisting")}
        confirmText={t("confirm.unifyCodexHistory.confirm")}
        onConfirm={(migrateExisting) =>
          void handleEnableConfirm(migrateExisting)
        }
        onCancel={() => setShowEnableConfirm(false)}
      />

      <ConfirmDialog
        isOpen={showDisableConfirm}
        title={t("confirm.unifyCodexHistoryOff.title")}
        message={t("confirm.unifyCodexHistoryOff.message")}
        checkboxLabel={
          showRestoreOption
            ? t("confirm.unifyCodexHistoryOff.restoreBackup")
            : undefined
        }
        checkboxDefaultChecked
        confirmText={t("confirm.unifyCodexHistoryOff.confirm")}
        onConfirm={(restoreBackup) => void handleDisableConfirm(restoreBackup)}
        onCancel={() => setShowDisableConfirm(false)}
      />
    </section>
  );
}
