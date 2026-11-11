import type { MediaModel } from "@/lib/api/media-studio";
import {
  mediaParametersValid,
  type MediaParameters,
} from "@/lib/mediaPreferences";
import { dt } from "./desktopI18n";

export function MediaParameterFields({
  model,
  value,
  onChange,
  disabled,
}: {
  model: MediaModel;
  value: MediaParameters;
  onChange: (value: MediaParameters) => void;
  disabled: boolean;
}) {
  const optionLabel = (value: string) =>
    ({
      auto: dt("自动"),
      low: dt("低"),
      medium: dt("中"),
      high: dt("高"),
      xhigh: dt("超高"),
      max: dt("最高"),
      opaque: dt("不透明"),
      transparent: dt("透明"),
      png: "PNG",
      jpeg: "JPEG",
      webp: "WebP",
    })[value] ?? value;
  const set = (patch: Partial<MediaParameters>) =>
    onChange({ ...value, ...patch });
  const select = (
    label: string,
    field: "quality" | "resolution" | "outputFormat" | "background",
    options?: string[],
  ) =>
    options?.length ? (
      <label className="space-y-1 text-xs">
        <span>{dt(label)}</span>
        <select
          aria-label={dt(label)}
          className="block w-full rounded-md border bg-background p-2 text-sm"
          disabled={disabled}
          value={value[field] ?? options[0]}
          onChange={(e) =>
            set(
              field === "outputFormat"
                ? { outputFormat: e.target.value, outputCompression: undefined }
                : { [field]: e.target.value },
            )
          }
        >
          {value[field] && !options.includes(value[field]!) && (
            <option value={value[field]} disabled>
              {value[field]}
            </option>
          )}
          {options.map((v) => (
            <option key={v} value={v}>
              {optionLabel(v)}
            </option>
          ))}
        </select>
      </label>
    ) : null;
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="sr-only">{dt("生成参数")}</legend>
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1 text-xs">
          <span>{dt("尺寸或比例")}</span>
          {model.customSize || model.kind === "video" ? (
            <>
              <input
                aria-label={dt("尺寸或比例")}
                list={`media-sizes-${model.id}`}
                className="block w-full rounded-md border bg-background p-2 text-sm"
                value={value.size}
                onChange={(e) => set({ size: e.target.value })}
              />
              <datalist id={`media-sizes-${model.id}`}>
                {model.sizes.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </>
          ) : (
            <select
              aria-label={dt("尺寸或比例")}
              className="block w-full rounded-md border bg-background p-2 text-sm"
              value={value.size}
              onChange={(e) => set({ size: e.target.value })}
            >
              {!model.sizes.includes(value.size) && (
                <option value={value.size} disabled>
                  {value.size || "—"}
                </option>
              )}
              {model.sizes.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          )}
        </label>
        {model.kind === "video" ? (
          <label className="space-y-1 text-xs">
            <span>{dt("分辨率")}</span>
            <input
              aria-label={dt("分辨率")}
              list={`media-resolutions-${model.id}`}
              className="block w-full rounded-md border bg-background p-2 text-sm"
              value={value.resolution ?? ""}
              onChange={(e) => set({ resolution: e.target.value || undefined })}
            />
            <datalist id={`media-resolutions-${model.id}`}>
              {model.resolutions?.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </label>
        ) : (
          select("分辨率", "resolution", model.resolutions)
        )}
        {select("画质", "quality", model.qualities)}
        {select("输出格式", "outputFormat", model.outputFormats)}
        {select("背景", "background", model.backgrounds)}
        {["jpeg", "webp"].includes(value.outputFormat ?? "") && (
          <label className="space-y-1 text-xs">
            <span>{dt("压缩质量（0–100）")}</span>
            <input
              aria-label={dt("压缩质量（0–100）")}
              type="number"
              min={0}
              max={100}
              step={1}
              placeholder={dt("默认")}
              className="block w-full rounded-md border bg-background p-2 text-sm"
              value={value.outputCompression ?? ""}
              onChange={(e) =>
                set({
                  outputCompression:
                    e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
            />
          </label>
        )}
        {model.kind === "video" && (
          <label className="space-y-1 text-xs">
            <span>{dt("请求时长（秒）")}</span>
            <input
              aria-label={dt(
                model.id === "muse-video" ? "Muse时长（秒）" : "请求时长（秒）",
              )}
              type="number"
              min={1}
              max={0xffffffff}
              step={1}
              className="block w-full rounded-md border bg-background p-2 text-sm"
              value={value.duration ?? ""}
              onChange={(e) =>
                set({
                  duration:
                    e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
          </label>
        )}
      </div>
      {!mediaParametersValid(model, value) && (
        <p role="alert" className="text-xs text-destructive dark:text-red-300">
          {dt("参数不兼容，请检查尺寸、格式和时长。")}
        </p>
      )}
      {model.customSize && model.kind === "image" && (
        <details className="text-xs text-muted-foreground">
          <summary>{dt("自定义尺寸规则")}</summary>
          <p className="mt-2">
            {dt(
              "宽高须为16的倍数，比例1:3至3:1，单边不超过3840，总像素655360至8294400；超过2560×1440为实验范围。",
            )}
          </p>
        </details>
      )}
    </fieldset>
  );
}
