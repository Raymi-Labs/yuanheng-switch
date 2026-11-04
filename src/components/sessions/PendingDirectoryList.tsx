import { useTranslation } from "react-i18next";
import { ProviderIcon } from "@/components/ProviderIcon";
import type { PendingSummary } from "@/lib/api/sessionSync";
import { getProviderIconName, getProviderLabel } from "./utils";

/** 按项目列出各来源客户端的待同步次数。 */
export function PendingDirectoryList({ summary }: { summary: PendingSummary }) {
  const { t } = useTranslation();
  return (
    <ul className="space-y-3">
      {summary.directories
        .filter((dir) => dir.total > 0)
        .map((dir) => (
          <li key={dir.projectDir} className="space-y-1">
            <p className="text-sm font-medium truncate" title={dir.projectDir}>
              {t("sessionSync.projectLabel", {
                defaultValue: "「{{name}}」项目",
                name: dir.label,
              })}
            </p>
            <div className="flex flex-wrap gap-2">
              {dir.sources
                .filter((src) => src.pending > 0)
                .map((src) => (
                  <span
                    key={src.sourceProvider}
                    className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs"
                  >
                    <ProviderIcon
                      icon={getProviderIconName(src.sourceProvider)}
                      name={src.sourceProvider}
                      size={14}
                    />
                    {t("sessionSync.sourceCount", {
                      defaultValue: "{{source}} 有 {{count}} 次",
                      source: getProviderLabel(src.sourceProvider, t),
                      count: src.pending,
                    })}
                  </span>
                ))}
            </div>
          </li>
        ))}
    </ul>
  );
}
