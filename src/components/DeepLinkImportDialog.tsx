import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import { useTranslation } from "react-i18next";

import type { DeepLinkImportRequest } from "@/lib/api/deeplink";
import { deeplinkApi } from "@/lib/api/deeplink";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PromptConfirmation } from "./deeplink/PromptConfirmation";
import { McpConfirmation } from "./deeplink/McpConfirmation";
import { SkillConfirmation } from "./deeplink/SkillConfirmation";

interface DeeplinkError {
  url: string;
  error: string;
}

export function DeepLinkImportDialog() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [request, setRequest] = useState<DeepLinkImportRequest | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const unlistenImport = listen<DeepLinkImportRequest>(
      "deeplink-import",
      (event) => {
        // Older app instances can still forward a provider link during upgrade.
        if ((event.payload.resource as string) === "provider") {
          toast.error(t("deeplink.providerImportRemoved"), {
            description: t("deeplink.providerImportRemovedDescription"),
          });
          return;
        }
        setRequest(event.payload);
        setIsOpen(true);
      },
    );
    const unlistenError = listen<DeeplinkError>("deeplink-error", (event) => {
      toast.error(t("deeplink.parseError"), {
        description: event.payload.error,
      });
    });

    return () => {
      void unlistenImport.then((fn) => fn());
      void unlistenError.then((fn) => fn());
    };
  }, [t]);

  const handleImport = async () => {
    if (!request) return;
    setIsImporting(true);
    try {
      const result = await deeplinkApi.importFromDeeplink(request);
      if (result.type === "prompt") {
        window.dispatchEvent(
          new CustomEvent("prompt-imported", {
            detail: { app: request.app },
          }),
        );
        toast.success(t("deeplink.promptImportSuccess"), {
          description: t("deeplink.promptImportSuccessDescription", {
            name: request.name,
          }),
        });
      } else if (result.type === "mcp") {
        await queryClient.invalidateQueries({
          queryKey: ["mcp", "all"],
          refetchType: "all",
        });
        if (result.failed.length > 0) {
          toast.warning(t("deeplink.mcpPartialSuccess"), {
            description: t("deeplink.mcpPartialSuccessDescription", {
              success: result.importedCount,
              failed: result.failed.length,
            }),
          });
        } else {
          toast.success(t("deeplink.mcpImportSuccess"), {
            description: t("deeplink.mcpImportSuccessDescription", {
              count: result.importedCount,
            }),
          });
        }
      } else {
        await queryClient.invalidateQueries({
          queryKey: ["skills"],
          refetchType: "all",
        });
        toast.success(t("deeplink.skillImportSuccess"), {
          description: t("deeplink.skillImportSuccessDescription", {
            repo: request.repo,
          }),
        });
      }
      setIsOpen(false);
    } catch (error) {
      toast.error(t("deeplink.importError"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsImporting(false);
    }
  };

  const title = request
    ? t(
        request.resource === "prompt"
          ? "deeplink.importPrompt"
          : request.resource === "mcp"
            ? "deeplink.importMcp"
            : "deeplink.importSkill",
      )
    : t("deeplink.confirmImport");
  const description = request
    ? t(
        request.resource === "prompt"
          ? "deeplink.importPromptDescription"
          : request.resource === "mcp"
            ? "deeplink.importMcpDescription"
            : "deeplink.importSkillDescription",
      )
    : t("deeplink.confirmImportDescription");

  return (
    <Dialog open={isOpen && Boolean(request)} onOpenChange={setIsOpen}>
      <DialogContent className="sm:max-w-[500px]" zIndex="top">
        {request && (
          <>
            <DialogHeader className="text-left sm:text-left">
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            <div className="max-h-[60vh] space-y-4 overflow-y-auto px-8 py-4">
              {request.resource === "prompt" && (
                <PromptConfirmation request={request} />
              )}
              {request.resource === "mcp" && (
                <McpConfirmation request={request} />
              )}
              {request.resource === "skill" && (
                <SkillConfirmation request={request} />
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setIsOpen(false)}
                disabled={isImporting}
              >
                {t("common.cancel")}
              </Button>
              <Button
                onClick={() => void handleImport()}
                disabled={isImporting}
              >
                {isImporting ? t("common.importing") : t("common.import")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
