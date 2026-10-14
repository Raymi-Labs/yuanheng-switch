import { useState } from "react";
import { Check, Languages, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { settingsApi } from "@/lib/api";
import { useSettingsQuery } from "@/lib/query";
import {
  LANGUAGE_OPTIONS,
  normalizeLanguage,
  persistLanguage,
  applyLanguageToDocument,
  type AppLanguage,
} from "@/i18n/languages";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { data: settings } = useSettingsQuery();
  const [isSaving, setIsSaving] = useState(false);
  const currentLanguage = normalizeLanguage(i18n.language);

  const changeLanguage = async (language: AppLanguage) => {
    if (language === currentLanguage || isSaving) return;

    const previousLanguage = currentLanguage;
    setIsSaving(true);
    persistLanguage(language);
    applyLanguageToDocument(language);
    await i18n.changeLanguage(language);

    try {
      const latestSettings = settings ?? (await settingsApi.get());
      await settingsApi.save({ ...latestSettings, language });
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch (error) {
      console.error("[LanguageSwitcher] Failed to save language", error);
      persistLanguage(previousLanguage);
      applyLanguageToDocument(previousLanguage);
      await i18n.changeLanguage(previousLanguage);
      toast.error(
        t("settings.saveFailedGeneric", {
          defaultValue: "Save failed, please try again",
        }),
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-full bg-muted/60 text-foreground/80 hover:bg-muted hover:text-foreground"
          aria-label={t("desktop.toolbar.language", {
            defaultValue: "Change language",
          })}
          title={t("desktop.toolbar.language", {
            defaultValue: "Change language",
          })}
          disabled={isSaving}
        >
          {isSaving ? (
            <Loader2 className="h-[18px] w-[18px] animate-spin" aria-hidden />
          ) : (
            <Languages className="h-[18px] w-[18px]" aria-hidden />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {LANGUAGE_OPTIONS.map((language) => (
          <DropdownMenuItem
            key={language.code}
            className="flex items-center justify-between gap-4"
            onSelect={() => void changeLanguage(language.code)}
          >
            <span>{language.nativeName}</span>
            {language.code === currentLanguage && (
              <Check className="h-4 w-4 text-primary" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
