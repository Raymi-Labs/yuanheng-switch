import { useState } from "react";
import { toast } from "@/lib/toast";
import { yuanhengApi } from "@/lib/api";
import { extractErrorMessage } from "@/utils/errorUtils";

export function useYuanhengPulse() {
  const [isOpening, setIsOpening] = useState(false);

  const openPulse = async () => {
    if (isOpening) return false;

    setIsOpening(true);
    try {
      return await yuanhengApi.openPulse();
    } catch (error) {
      toast.error(extractErrorMessage(error) || "打开脉冲控制台失败");
      return false;
    } finally {
      setIsOpening(false);
    }
  };

  return { isOpening, openPulse };
}
