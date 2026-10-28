import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, Settings2 } from "lucide-react";
import { toast } from "sonner";
import {
  settingsApi,
  type YuanhengConnectionStatus,
  yuanhengTerminalModels,
} from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import {
  buildTraeSetupPreview,
  TRAE_EDITIONS,
  traeApiFormats,
  type TraeEdition,
  type TraeModelSelection,
} from "@/lib/traeSetup";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CompactSelectPicker } from "./CompactSelectPicker";
import { ToolModelPicker } from "./ToolModelPicker";
import { TraeInstallationActions } from "./TraeInstallationActions";
import { dt } from "./desktopI18n";

/** An assisted setup surface, deliberately outside managed tool readiness. */
export function TraeSetupGuide({
  connection,
}: {
  connection?: YuanhengConnectionStatus;
}) {
  return (
    <TraeSetupGuideContent
      key={JSON.stringify([
        connection?.connected,
        connection?.userId,
        connection?.baseUrl,
      ])}
      connection={connection}
    />
  );
}

function TraeSetupGuideContent({
  connection,
}: {
  connection?: YuanhengConnectionStatus;
}) {
  const [open, setOpen] = useState(false);
  const [edition, setEdition] = useState<TraeEdition>("china");
  const [selection, setSelection] = useState<TraeModelSelection>();
  const [protocol, setProtocol] = useState("openai-chat");
  const [pending, setPending] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const target = TRAE_EDITIONS[edition];
  const preview = buildTraeSetupPreview(
    connection,
    selection,
    protocol,
    edition,
  );
  const errorMessage = preview.ready
    ? null
    : {
        connection: "请先连接元衡账号，再选择分组和模型。",
        origin: "当前连接地址不受此向导支持，未生成请求地址。",
        selection: "请选择 TRAE 要使用的分组和模型。",
        catalog: "该分组与模型组合已不可用，请刷新目录或重新选择。",
        protocol: "请选择支持的 API 格式。",
      }[preview.reason];

  const run = async (action: () => Promise<unknown>, copied = false) => {
    if (locked.current) return;
    locked.current = true;
    setPending(true);
    try {
      await action();
      if (copied && mounted.current) toast.success(dt("已复制"));
    } catch {
      // Native errors can contain paths or URL details. Keep user feedback fixed.
      if (mounted.current)
        toast.error(
          dt(copied ? "复制失败，请手动选中复制。" : "打开失败，请重试。"),
        );
    } finally {
      locked.current = false;
      if (mounted.current) setPending(false);
    }
  };

  return (
    <section
      className="rounded-2xl border bg-card p-4"
      aria-label={dt("TRAE 辅助配置")}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{dt("TRAE 辅助配置")}</h3>
          <span className="text-xs text-amber-700 dark:text-amber-300">
            {dt("实验接入")}
          </span>
          <p className="mt-1 text-xs text-muted-foreground">
            {dt(
              "生成官方自定义模型的填写说明；请在 TRAE 内保存并选择模型。复制参数不代表已接通。",
            )}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Settings2 className="h-3.5 w-3.5" />
          {dt("配置 TRAE")}
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{dt("TRAE 自定义模型配置")}</DialogTitle>
            <DialogDescription>
              {dt(
                "国内版与国际版分别配置，账号和模型不会自动迁移。请先用小任务验证当前版本。",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto px-6 py-4 text-sm">
            <CompactSelectPicker
              label={dt("TRAE 版本")}
              value={edition}
              options={Object.entries(TRAE_EDITIONS).map(([value, entry]) => ({
                value,
                label: dt(entry.label),
              }))}
              disabled={pending}
              onChange={(value) => {
                if (value === "china" || value === "international") {
                  setEdition(value);
                }
              }}
            />
            <p className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-xs">
              {dt(
                "请先在 TRAE 登录官方账号。未登录时，Models 页面只显示登录入口，无法添加自定义模型。",
              )}
            </p>
            <TraeInstallationActions edition={edition} />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  void run(() => settingsApi.openExternal(target.downloadUrl))
                }
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {dt("TRAE 官方下载")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  void run(() => settingsApi.openExternal(target.docsUrl))
                }
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {dt("TRAE 官方说明")}
              </Button>
            </div>
            {connection?.connected && (
              <ToolModelPicker
                connection={connection}
                models={yuanhengTerminalModels(connection).filter(
                  (model) => !connection.imageGenerationModels?.includes(model),
                )}
                model={selection?.model}
                group={selection?.group}
                tool="TRAE"
                disabled={pending}
                onChange={setSelection}
              />
            )}
            <div className="space-y-2">
              <p>{dt("API 格式")}</p>
              <CompactSelectPicker
                label={dt("TRAE API 格式")}
                value={protocol}
                options={traeApiFormats(edition)}
                disabled={pending}
                onChange={setProtocol}
              />
              <p className="text-xs text-muted-foreground">
                {dt(
                  "请选择渠道实际支持的格式；元衡不会在此向导中自动转换协议或测试模型。",
                )}
              </p>
            </div>
            {errorMessage && (
              <p role="status" className="text-amber-700 dark:text-amber-300">
                {dt(errorMessage)}
              </p>
            )}
            {preview.ready && (
              <>
                {edition === "china" && preview.model === "gpt-6-astra" && (
                  <div className="space-y-2 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-xs">
                    <p>
                      {dt(
                        "gpt-6-astra 已在 TRAE 国内版 3.4.9 的 Responses 格式完成文件任务验证。建议新增独立模型条目，API 格式选 OpenAI Responses API，模型系列与思考模式保持默认；保留原条目以便对照。",
                      )}
                    </p>
                    {protocol !== "openai-responses" && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => setProtocol("openai-responses")}
                      >
                        {dt("使用 Responses 配置")}
                      </Button>
                    )}
                  </div>
                )}
                <p>{dt("所选分组：{{group}}", { group: preview.group })}</p>
                <ol className="list-decimal space-y-3 pl-5">
                  <li>
                    {dt(
                      "打开 TRAE 设置 → Models（模型）→ Add Model（添加模型）→ Custom Model（自定义模型）。",
                    )}
                  </li>
                  <li>
                    {dt(
                      "API Format 选择 {{format}}，打开 Full URL（完整地址）开关。",
                      { format: preview.apiFormat },
                    )}
                    <CopyField
                      label="Custom Request URL"
                      value={preview.requestUrl}
                      disabled={pending}
                      onCopy={() =>
                        void run(() => copyText(preview.requestUrl), true)
                      }
                    />
                    <CopyField
                      label="Model ID"
                      value={preview.model}
                      disabled={pending}
                      onCopy={() =>
                        void run(() => copyText(preview.model), true)
                      }
                    />
                  </li>
                  <li>
                    {dt(
                      "在元衡令牌管理中选择或创建同一分组的专用 API Key，再粘贴到 TRAE 的 API Key 栏。不要使用登录密码或 PROXY_MANAGED。",
                    )}
                    <Button
                      className="mt-2"
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        void run(() =>
                          settingsApi.openExternal(preview.tokenPageUrl),
                        )
                      }
                    >
                      {dt("打开元衡令牌管理")}
                    </Button>
                  </li>
                  <li>
                    {dt(
                      "在 TRAE 内保存，并在输入框的模型菜单选择刚添加的模型。发送测试消息后，到元衡请求日志核对模型和分组；测试会产生用量。",
                    )}
                  </li>
                  <li>
                    {dt(
                      "需要切换其他模型时，用对应 Model ID 再添加一条自定义模型，然后在 TRAE 输入框的模型菜单切换。",
                    )}
                  </li>
                  <li>
                    {dt(
                      "测试文件功能时，请选择一个专用工作文件夹。若操作被审批拒绝，先查看拒绝原因，不要关闭安全审批。",
                    )}
                  </li>
                </ol>
              </>
            )}
            <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
              <p>
                {dt(
                  "如果报错提示不支持思考强度 none，请检查 TRAE 模型的高级配置 → 模型系列、思考模式，以及对话中的思考强度。按服务商支持的值调整后再测试；保存成功不代表请求兼容。",
                )}
              </p>
              <p>
                {dt(
                  "连接检查出现 Empty response data 时，先核对完整地址与请求日志，避免反复重试。直接保存只保留配置，仍需用实际任务验证。",
                )}
              </p>
              <p>
                {dt(
                  "保存后请重新打开模型设置核对参数，并在新任务里确认选中正确条目。若参数回到原值，不要反复重试；连接检查成功不代表实际任务使用了新参数。旧版看不到 Responses 时请先更新 TRAE。",
                )}
              </p>
              <p>
                {dt(
                  "请先验证停止生成是否及时生效；界面停止不一定代表上游请求已结束，费用以平台记录为准。",
                )}
              </p>
              <p>
                {dt(
                  "这里选择分组只生成说明，不会修改 API Key 的分组、权限或 TRAE 配置；实际路由和计费以所填令牌为准。",
                )}
              </p>
              <p>
                {dt(
                  "TRAE 的保存流程使用官方账号服务，请先确认其凭据处理规则。此向导不读取或提交密钥，也不替代 TRAE 官方登录。",
                )}
              </p>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{dt("关闭")}</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function CopyField({
  label,
  value,
  disabled,
  onCopy,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="mt-2 rounded-lg border p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Button
          size="sm"
          variant="ghost"
          aria-label={dt("复制 {{field}}", { field: label })}
          disabled={disabled}
          onClick={onCopy}
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
      <code className="block select-text break-all text-xs">{value}</code>
    </div>
  );
}
