import { useQuery } from "@tanstack/react-query";
import { yuanhengApi } from "@/lib/api/yuanheng";
import { dt } from "./desktopI18n";

/** Does not participate in the all-tools bootstrap or authorize launching. */
export function AccioReleaseNotice() {
  const query = useQuery({
    queryKey: ["desktop", "accio-official-release"],
    queryFn: () => yuanhengApi.getAccioReleaseStatus(),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 6 * 60 * 60 * 1000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const data = query.data;
  return (
    <div className="space-y-1" aria-live="polite">
      {query.isPending && <p>{dt("正在后台查询 Accio 官方版本…")}</p>}
      {data?.latestVersion && (
        <p>
          {dt(
            data.stale || query.isError
              ? "上次检测的官方版本：{{version}}（信息已过期）"
              : "官方发布版本：{{version}}",
            { version: data.latestVersion },
          )}
        </p>
      )}
      {data?.latestVersion &&
        !data.latestVerified &&
        !data.stale &&
        !query.isError && (
          <p role="status">
            {dt(
              "官方已有尚未验证的版本。请先检查元衡更新；当前已验证版本仍可使用。",
            )}
          </p>
        )}
      {(query.isError || data?.error) && (
        <p>{dt("官方版本查询失败，不影响本机兼容检查。请稍后重试。")}</p>
      )}
      {data?.checkedAt && (
        <p>
          {dt("上次成功检查：{{time}}", {
            time: new Date(data.checkedAt * 1000).toLocaleString(),
          })}
        </p>
      )}
      <button
        type="button"
        className="underline underline-offset-2 disabled:opacity-50"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        {dt("检查官方版本（有缓存）")}
      </button>
    </div>
  );
}
