import { MessageSquareWarning } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { openErrorFeedback } from "@/lib/feedbackContext";

export function ErrorFeedbackButton() {
  const { t } = useTranslation();
  return (
    <Button variant="outline" size="sm" onClick={() => openErrorFeedback()}>
      <MessageSquareWarning className="h-3.5 w-3.5" />
      {t("feedback.title")}
    </Button>
  );
}
