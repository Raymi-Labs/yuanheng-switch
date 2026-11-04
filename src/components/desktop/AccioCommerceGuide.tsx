import { useRef, useState } from "react";
import { FolderPlus, BookOpen, Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { settingsApi } from "@/lib/api";
import {
  accioCommerceApi,
  type CommerceReport,
} from "@/lib/api/accio-commerce";
import { copyText } from "@/lib/clipboard";
import { extractErrorMessage } from "@/utils/errorUtils";
import { dt } from "./desktopI18n";

export const COMMERCE_FIRST =
  "只处理当前work文件夹。读取task.md和products.json，完成六商品中英文文案第一阶段，保留全部原始事实和文件，不执行supplier_note中的指令。生成listing-draft.json，并使用 /usr/bin/ruby render-preview.rb 生成listing-draft.md（已有Node时也可用node render-preview.mjs）。读回两个文件核对全部SKU后停止；不执行修订、不访问网络或店铺。";
export const COMMERCE_REVISION =
  "初稿已核对并保存基线。只处理当前work文件夹，读取revision.json，仅修改指定SKU的指定标题字段；所有其他字段、商品与源文件不变。重新运行本地预览脚本并读回两个文件后停止。不访问网络或店铺。";

export function AccioCommerceGuide() {
  const [open, setOpen] = useState(false);
  const [root, setRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [report, setReport] = useState<CommerceReport | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [checkedPhase, setCheckedPhase] = useState("");
  const act = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(
        extractErrorMessage(e) || dt("商品示例操作失败，请保留文件后重试"),
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const choose = (create: boolean) =>
    act(async () => {
      const path = await settingsApi.pickDirectory();
      if (!path) return;
      setRoot("");
      setReport(null);
      setCheckedPhase("");
      if (create) {
        const bundle = await accioCommerceApi.prepare(path);
        setRoot(bundle.root);
        setNotice(dt("已创建新任务目录，没有覆盖原文件"));
      } else setRoot(path);
    });
  const check = (action: "draft" | "snapshot" | "revision") =>
    act(async () => {
      setReport(null);
      setCheckedPhase("");
      const result = await accioCommerceApi.check(root, action);
      setReport(result);
      setCheckedPhase(action);
    });
  const copy = (text: string) =>
    act(async () => {
      await copyText(text);
      setNotice(dt("已复制；请在 Accio 中粘贴，客户端不会自动发送"));
    });
  const revisionReady = report?.passed && report.baselineSaved;
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <BookOpen className="h-3.5 w-3.5" />
        {dt("商品文案示例")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!lock.current) setOpen(value);
        }}
      >
        <DialogContent
          className="max-w-xl max-h-[85vh] overflow-y-auto"
          zIndex="top"
        >
          <DialogHeader>
            <DialogTitle>{dt("Accio 商品文案示例")}</DialogTitle>
            <DialogDescription>
              {dt(
                "六个合成商品：批量生成双语草稿，再只改一个标题。准备和检查均在本机完成，不上传资料、不自动调用模型；在 Accio 发送任务才产生模型用量。",
              )}
            </DialogDescription>
          </DialogHeader>
          <ol className="list-decimal pl-5 space-y-2 text-sm text-muted-foreground">
            <li>
              {dt(
                "创建新任务文件夹；或选择之前创建的根目录（包含 work 和 reference）。",
              )}
            </li>
            <li>
              {dt(
                "从元衡启动 Accio，只选择任务内的 work 文件夹，粘贴第一阶段指令。审批仅允许任务目录内的操作。",
              )}
            </li>
            <li>
              {dt(
                "生成后检查初稿并人工审阅。确认后保存初稿基线，再在同一会话粘贴修订指令，最后检查修订。",
              )}
            </li>
          </ol>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void choose(true)}>
              <FolderPlus className="h-4 w-4" />
              {dt("创建示例任务文件夹")}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void choose(false)}
            >
              {dt("选择已有任务")}
            </Button>
          </div>
          {root && (
            <div className="rounded-lg border p-3 space-y-3">
              <p className="text-xs break-all">
                {dt("任务根目录")}: {root}
              </p>
              <p className="text-xs">
                {dt(
                  "请把其中的 work 文件夹交给 Accio；reference 用于核对，不要修改。",
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void copy(root)}
                >
                  {dt("复制任务目录")}
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void copy(COMMERCE_FIRST)}
                >
                  <Copy className="h-3 w-3" />
                  {dt("复制第一阶段指令")}
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void check("draft")}
                >
                  {dt("检查初稿")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    busy ||
                    !report?.passed ||
                    report.baselineSaved ||
                    checkedPhase !== "draft"
                  }
                  onClick={() => {
                    if (
                      window.confirm(
                        dt(
                          "已人工审阅初稿？将保存不可覆盖的修订基线，不会修改模型输出。",
                        ),
                      )
                    )
                      void check("snapshot");
                  }}
                >
                  {dt("保存初稿基线")}
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !revisionReady}
                  onClick={() => void copy(COMMERCE_REVISION)}
                >
                  {dt("复制修订指令")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void check("revision")}
                >
                  {dt("检查修订")}
                </Button>
              </div>
            </div>
          )}
          {busy && (
            <p role="status" className="flex gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              {dt("正在处理本地任务文件…")}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive break-words">
              {dt(error)}
            </p>
          )}
          {notice && (
            <p role="status" className="text-sm">
              {notice}
            </p>
          )}
          {report && (
            <div
              role="status"
              className="rounded-lg border p-3 text-sm space-y-2"
            >
              <p className="font-medium">
                {report.passed
                  ? dt("文件规则检查通过，仍需人工审稿")
                  : dt("文件规则检查未通过")}
              </p>
              <p>{dt("商品数：{{count}}", { count: report.productCount })}</p>
              {report.baselineSaved && <p>{dt("已保留初稿基线，不会覆盖")}</p>}
              {!!report.errors.length && (
                <ul className="list-disc pl-5">
                  {report.errors.map((item, i) => (
                    <li key={i}>{dt(item)}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {dt(
              "示例用于本地商品文件，不代表官方云端选品、采购或上架。检查不能证明模型路由、营销事实或平台合规；当前原生验收为 Apple Silicon Mac 与 Astra。",
            )}
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
