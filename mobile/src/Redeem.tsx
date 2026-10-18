import { useState } from "react";
import { CheckCircle2, Gift, X } from "lucide-react";
import { api, errorText, quotaAmount, Redemption } from "./api";
import { Notice } from "./App";

export function Redeem({
  perUnit,
  close,
  refresh,
}: {
  perUnit: number;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<Redemption>();
  const [choice, setChoice] = useState<Redemption>();
  const [mode, setMode] = useState("stack");
  const [target, setTarget] = useState(0);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const value = await api.raw<Redemption>("redeem", {
        key: code.trim(),
        ...(choice
          ? { purchase_mode: mode, renew_target_subscription_id: target }
          : {}),
      });
      if (!value.success) {
        if (
          [
            "redeem_select_purchase_mode",
            "redeem_select_renew_target",
          ].includes(value.data?.code || "")
        ) {
          setChoice(value.data);
          setMessage(value.message || "请选择兑换方式后继续");
          return;
        }
        throw new Error(value.message || "兑换未成功，请重试");
      }
      setResult(value.data);
      setCode("");
      setChoice(undefined);
      await refresh();
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const pendingBenefit =
    result?.benefit_type &&
    result.benefit_type !== "quota" &&
    !(result.quota_added && result.quota_added > 0);
  return (
    <div className="sheet-backdrop">
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="使用兑换码"
      >
        <div className="sheet-heading">
          <h2>使用兑换码</h2>
          <button
            className="icon-button"
            aria-label="关闭兑换码"
            onClick={close}
            disabled={busy}
          >
            <X size={20} />
          </button>
        </div>
        {result ? (
          <div className="redeem-success">
            <CheckCircle2 size={42} />
            <h2>{pendingBenefit ? "兑换码已核销" : "兑换成功"}</h2>
            <p>
              {pendingBenefit
                ? result.action_summary ||
                  `已生成${result.plan_title || result.product_name || "权益"}待领取记录，请在官网完成领取。`
                : `已增加额度 ${quotaAmount(result.quota_added || 0, perUnit)}`}
            </p>
            {pendingBenefit && (
              <button
                className="primary full"
                onClick={() =>
                  void api.open("topup").catch((e) => setMessage(errorText(e)))
                }
              >
                前往官网领取权益
              </button>
            )}
            <Notice text={message} />
            <button className="secondary full" onClick={close}>
              完成
            </button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="redeem-intro">
              <Gift size={32} />
              <p>输入元衡兑换码，领取对应额度或权益。</p>
            </div>
            <label>
              兑换码
              <input
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setChoice(undefined);
                  setTarget(0);
                }}
                placeholder="粘贴兑换码"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={256}
                required
                disabled={busy}
              />
            </label>
            {choice?.code === "redeem_select_purchase_mode" && (
              <label>
                兑换方式
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="stack">叠加新套餐</option>
                  <option value="renew">续费已有套餐</option>
                </select>
              </label>
            )}
            {choice?.code === "redeem_select_renew_target" && (
              <label>
                续费目标
                <select
                  value={target}
                  onChange={(e) => setTarget(Number(e.target.value))}
                  required
                >
                  <option value={0}>请选择套餐</option>
                  {(choice.options || []).map((option) => {
                    const item =
                      (option as unknown as { subscription?: typeof option })
                        .subscription || option;
                    return (
                      <option value={item.id} key={item.id}>
                        {item.plan_title || `套餐 #${item.id}`}
                        {item.end_time
                          ? ` · 到期 ${new Date(item.end_time * 1000).toLocaleDateString("zh-CN")}`
                          : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
            )}
            <Notice text={message} />
            <button
              className="primary full"
              disabled={
                busy ||
                !code.trim() ||
                (choice?.code === "redeem_select_renew_target" && !target)
              }
            >
              {busy ? "正在核验…" : "确认兑换"}
            </button>
            <p className="footnote">
              核销结果以后台为准。套餐或令牌产品兑换后，可能需要到官网继续领取。
            </p>
          </form>
        )}
      </section>
    </div>
  );
}
