import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowRight, FolderPlus, Info, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  nativePluginsApi,
  type NativePluginStatus,
  type NativePluginPlan,
  type NativePluginRow,
  type PluginAction,
  type PluginVerification,
} from "@/lib/api/native-plugins";
import { extractErrorMessage } from "@/utils/errorUtils";
import { dt } from "./desktopI18n";

export function NativePluginsPanel({ tool }: { tool: string }) {
  // The parent keys this panel by the actual tool, never by the generic AppId.
  const [status, setStatus] = useState<NativePluginStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<"discover" | "installed">("discover");
  const [search, setSearch] = useState("");
  const [plan, setPlan] = useState<NativePluginPlan | null>(null);
  const [remove, setRemove] = useState<NativePluginRow | null>(null);
  const [verification, setVerification] = useState<{
    name: string;
    result: PluginVerification;
  } | null>(null);
  const alive = useRef(true);
  const lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = async (work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      if (alive.current) setError(extractErrorMessage(e));
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const refresh = async () => {
    const next = await nativePluginsApi.status(tool);
    if (alive.current) {
      setStatus(next);
      setVerification(null);
    }
  };
  // Explicit refresh: merely opening the capability center never starts Codex.
  const prepare = (builtinId: string | null) =>
    run(async () => {
      if (!status) return;
      let source: string | null = null;
      if (!builtinId) {
        const selected = await open({
          directory: true,
          multiple: false,
          title: dt("选择插件目录"),
        });
        if (!alive.current || !selected || typeof selected !== "string") return;
        source = selected;
      }
      const next = await nativePluginsApi.plan(
        tool,
        status.targetId,
        source,
        builtinId,
      );
      if (alive.current) setPlan(next);
    });
  const install = () =>
    run(async () => {
      if (!plan || !status || plan.targetId !== status.targetId) return;
      const token = plan.token;
      setPlan(null); // Single-use even if the IPC times out.
      try {
        await nativePluginsApi.install(tool, status.targetId, token);
      } finally {
        if (alive.current) await refresh();
      }
      if (alive.current) {
        setTab("installed");
        setMessage(dt("已安装。请在 Codex 新建聊天加载插件。"));
      }
    });
  const act = (row: NativePluginRow, action: PluginAction) =>
    run(async () => {
      if (!status) return;
      setRemove(null);
      const result = await nativePluginsApi.action(
        tool,
        status.targetId,
        row.id,
        action,
      );
      if (!alive.current) return;
      if (action === "verify") setVerification({ name: row.name, result });
      else {
        await refresh();
        if (alive.current) setMessage(dt("操作完成，新聊天生效。"));
      }
    });
  const visible = (status?.plugins ?? []).filter((row) =>
    `${row.name} ${row.description}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <section className="my-6 space-y-4" aria-label={dt("Codex 插件")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{dt("Codex 插件")}</h2>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !status}
            onClick={() => void prepare(null)}
          >
            <FolderPlus className="h-4 w-4" />
            {dt("导入插件")}
          </Button>
          <Button
            variant={status ? "ghost" : "default"}
            size="sm"
            disabled={busy}
            onClick={() => void run(refresh)}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {dt(status ? "刷新插件" : "连接原生引擎")}
          </Button>
        </div>
      </div>
      {error && (
        <p
          role="alert"
          className="break-words text-sm text-destructive dark:text-red-300"
        >
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {!status && !busy && (
        <p className="text-sm text-muted-foreground">
          {dt("连接后管理此目标的本地插件。")}
        </p>
      )}
      {status && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
            <div
              role="group"
              aria-label={dt("插件视图")}
              className="flex gap-1"
            >
              <Button
                size="sm"
                variant={tab === "discover" ? "secondary" : "ghost"}
                aria-pressed={tab === "discover"}
                onClick={() => setTab("discover")}
              >
                {dt("发现")}
              </Button>
              <Button
                size="sm"
                variant={tab === "installed" ? "secondary" : "ghost"}
                aria-pressed={tab === "installed"}
                onClick={() => setTab("installed")}
              >
                {dt("本机管理")}
              </Button>
            </div>
            {tab === "installed" && (
              <input
                aria-label={dt("搜索插件")}
                placeholder={dt("搜索插件")}
                className="min-w-0 rounded-md border bg-background px-3 py-2 text-sm"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            )}
          </div>
          {tab === "discover" ? (
            <div className="divide-y">
              {[
                ["review", "代码审查", "只读审查流程"],
                ["docs", "OpenAI 官方文档", "公开文档 MCP"],
              ].map(([id, name, detail]) => (
                <div
                  key={id}
                  className="flex items-center justify-between gap-4 py-4"
                >
                  <div>
                    <h3 className="text-sm font-medium">{dt(name)}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {dt(detail)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void prepare(id)}
                    aria-label={dt("检查 {{name}}", { name: dt(name) })}
                  >
                    {dt("检查安装")}
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="divide-y">
              {!visible.length && (
                <p className="py-6 text-sm text-muted-foreground">
                  {dt(search ? "没有匹配的插件" : "尚未通过此客户端导入插件")}
                </p>
              )}
              {visible.map((row) => (
                <div
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-4"
                >
                  <div className="min-w-0 flex-1">
                    <h3 className="break-words text-sm font-medium">
                      {row.name}{" "}
                      <span className="text-xs font-normal text-muted-foreground">
                        {row.version}
                      </span>
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {dt(
                        row.changed
                          ? "内容已变化"
                          : row.pending
                            ? "结果待核对"
                            : !row.installed
                              ? "已卸载"
                              : row.enabled
                                ? "已启用，待新聊天加载"
                                : "已停用",
                      )}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {row.installed && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || row.changed}
                        onClick={() => void act(row, "verify")}
                        aria-label={dt("检测 {{name}}", { name: row.name })}
                      >
                        {dt("检测加载")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || row.pending || row.changed}
                      onClick={() =>
                        void act(
                          row,
                          row.installed
                            ? row.enabled
                              ? "disable"
                              : "enable"
                            : "reinstall",
                        )
                      }
                      aria-label={dt("切换 {{name}}", { name: row.name })}
                    >
                      {dt(
                        row.installed
                          ? row.enabled
                            ? "停用"
                            : "启用"
                          : "重新安装",
                      )}
                    </Button>
                    {(row.installed || row.pending || row.changed) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setRemove(row)}
                        aria-label={dt("卸载 {{name}}", { name: row.name })}
                      >
                        {dt("卸载")}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {verification && (
            <div role="status" className="rounded-md bg-muted/50 p-3 text-sm">
              <p className="font-medium">{verification.name}</p>
              <p>
                {dt("原生引擎发现 {{count}} 个技能；声明 {{mcp}} 个 MCP。", {
                  count: verification.result.discoveredSkills,
                  mcp: verification.result.declaredMcp,
                })}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {dt(
                  "未执行模型或业务工具；外部授权及当前桌面会话加载状态未验证。",
                )}
              </p>
            </div>
          )}
          <details className="text-xs text-muted-foreground">
            <summary className="inline-flex cursor-pointer items-center gap-1 rounded focus-visible:outline focus-visible:outline-2">
              <Info className="h-3.5 w-3.5" />
              {dt("插件范围与权限")}
            </summary>
            <p className="mt-2 leading-relaxed">
              {dt(
                "这里只管理通过元衡导入的本地插件，不接管官方或其他来源的安装。MCP 连接可能发送数据，脚本按 Codex 权限运行；需要账号的服务仍须在 Codex 中授权。",
              )}
            </p>
          </details>
        </>
      )}
      <Dialog
        open={!!plan}
        onOpenChange={(value) => {
          if (!value && !busy) setPlan(null);
        }}
      >
        {plan && (
          <DialogContent className="max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{dt("确认安装插件")}</DialogTitle>
              <DialogDescription>
                {plan.info.name} · {plan.info.version}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 px-6 pb-6">
              <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm">
                <dt>{dt("许可证")}</dt>
                <dd>{plan.info.license || dt("未声明，请先确认使用权")}</dd>
                <dt>{dt("文件")}</dt>
                <dd>
                  {plan.info.fileCount} · {(plan.info.bytes / 1024).toFixed(1)}{" "}
                  KB
                </dd>
                <dt>{dt("技能")}</dt>
                <dd>{plan.info.skills}</dd>
              </dl>
              {plan.info.connections?.length > 0 && (
                <div className="space-y-1 text-sm">
                  <p className="font-medium">{dt("连接目标")}</p>
                  {plan.info.connections.map((value) => (
                    <p className="break-all font-mono text-xs" key={value}>
                      {value}
                    </p>
                  ))}
                </div>
              )}
              <p className="text-sm">
                {dt(
                  "安装会写入此目标的插件缓存与配置；不改变模型或登录配置。新聊天才会加载。",
                )}
              </p>
              {(plan.info.hasMcp ||
                plan.info.hasApps ||
                plan.info.hasHooks ||
                plan.info.executableFiles > 0) && (
                <div className="space-y-2 rounded-md border border-amber-600/40 bg-amber-500/10 p-3 text-sm">
                  {plan.info.hasMcp && (
                    <p>
                      {dt("包含 MCP：启用后可能启动程序或向外部服务发送数据。")}
                    </p>
                  )}
                  {plan.info.hasApps && (
                    <p>
                      {dt(
                        "包含账号连接：安装不会授予外部服务权限，请在 Codex 中授权。",
                      )}
                    </p>
                  )}
                  {(plan.info.hasHooks || plan.info.executableFiles > 0) && (
                    <p>
                      {dt(
                        "包含脚本或钩子：可能读写本机文件。请先审查来源，原生钩子仍需单独信任。",
                      )}
                    </p>
                  )}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setPlan(null)}>
                  {dt("取消")}
                </Button>
                <Button disabled={busy} onClick={() => void install()}>
                  {dt("安装此版本")}
                </Button>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
      <Dialog
        open={!!remove}
        onOpenChange={(value) => {
          if (!value) setRemove(null);
        }}
      >
        {remove && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{dt("卸载插件")}</DialogTitle>
              <DialogDescription>{remove.name}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 px-6 pb-6">
              <p className="text-sm">
                {dt(
                  "将由 Codex 删除插件缓存与安装配置；保留本地来源快照用于重装。已授权的外部服务不会自动撤权，运行中的聊天也不会被终止。",
                )}
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setRemove(null)}>
                  {dt("取消")}
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void act(remove, "remove")}
                >
                  {dt("确认卸载")}
                </Button>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}
