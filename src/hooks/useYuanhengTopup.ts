import { useState } from "react";
import { toast } from "@/lib/toast";
import { yuanhengApi } from "@/lib/api";
import { extractErrorMessage } from "@/utils/errorUtils";

export function useYuanhengTopup() {
  const [isOpening, setIsOpening] = useState(false);

  const openTopup = async () => {
    if (isOpening) return false;

    setIsOpening(true);
    try {
      return await yuanhengApi.openTopup();
    } catch (error) {
      toast.error(extractErrorMessage(error) || "打开充值窗口失败");
      return false;
    } finally {
      setIsOpening(false);
    }
  };

  return { isOpening, openTopup };
}
