import { useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MediaModel } from "@/lib/api/media-studio";
import {
  MEDIA_INSPIRATION,
  type MediaInspiration,
} from "@/lib/mediaInspiration";
import { dt } from "./desktopI18n";
import "./mediaInspiration.css";

interface Props {
  models: MediaModel[];
  unavailable: boolean;
  locked: boolean;
  onUse: (example: MediaInspiration) => boolean;
  onCreate: () => void;
}

export function MediaInspirationGallery({
  models,
  unavailable,
  locked,
  onUse,
  onCreate,
}: Props) {
  const [filter, setFilter] = useState<"all" | "image" | "video">("all");
  const [detail, setDetail] = useState<MediaInspiration | null>(null);
  const eligible = (item: MediaInspiration) =>
    !unavailable &&
    models.some((m) => m.id === item.model && m.kind === item.kind);
  const items = MEDIA_INSPIRATION.filter(
    (item) => filter === "all" || item.kind === filter,
  );
  return (
    <section className="media-inspiration" aria-label={dt("灵感广场")}>
      <header className="inspiration-intro">
        <div>
          <h2>{dt("灵感广场")}</h2>
        </div>
        <button className="inspiration-start" type="button" onClick={onCreate}>
          <Sparkles size={16} />
          {dt("开始创作")}
          <ArrowRight size={17} />
        </button>
      </header>
      <div className="inspiration-toolbar">
        <div
          className="inspiration-filters"
          role="group"
          aria-label={dt("筛选灵感")}
        >
          {(["all", "image", "video"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {dt(
                value === "all"
                  ? "全部灵感"
                  : value === "image"
                    ? "图像创作"
                    : "镜头灵感",
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="inspiration-grid">
        {items.map((item, index) => (
          <article
            key={item.id}
            className={`inspiration-card inspiration-${item.id}`}
          >
            <button
              type="button"
              className="inspiration-cover"
              aria-label={dt("查看灵感：{{title}}", { title: dt(item.title) })}
              onClick={() => setDetail(item)}
            >
              <img
                src={item.art}
                alt={dt(item.description)}
                loading={index === 1 ? "lazy" : "eager"}
                decoding="async"
                width={item.width}
                height={item.height}
              />
            </button>
            <div className="inspiration-card-footer">
              <div>
                <h3>{dt(item.title)}</h3>
                <p className="inspiration-description">
                  {dt(item.description)}
                </p>
                <span className="inspiration-model-label">
                  {dt("推荐模型：{{model}}", { model: item.label })}
                </span>
              </div>
              <button
                type="button"
                className="inspiration-use"
                disabled={locked || !eligible(item)}
                onClick={() => onUse(item)}
                aria-label={dt("使用 {{model}} 灵感", { model: item.label })}
              >
                {dt(
                  eligible(item)
                    ? "立即创作"
                    : unavailable
                      ? "等待模型目录"
                      : "当前账号不可用",
                )}
                <ArrowRight size={20} />
              </button>
            </div>
          </article>
        ))}
      </div>
      {items.length === 0 && (
        <div className="inspiration-empty" role="status">
          <Sparkles size={24} aria-hidden="true" />
          <h3>{dt("视频灵感准备中")}</h3>
          <p>{dt("这里暂不展示视频样片，你仍可前往工作台创作。")}</p>
          <button
            type="button"
            className="inspiration-start"
            onClick={onCreate}
          >
            {dt("前往创作工作台")}
            <ArrowRight size={16} />
          </button>
        </div>
      )}
      <footer className="inspiration-disclosure">
        <span>✳</span>
        <p>
          {dt(
            "配图为灵感示意，非推荐模型的实测结果。立即创作仅填入草稿，点击生成后才提交计费。",
          )}
        </p>
      </footer>
      <Dialog
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        {detail && (
          <DialogContent className="inspiration-dialog max-h-[88vh] max-w-3xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{dt(detail.title)}</DialogTitle>
              <DialogDescription>
                {dt(detail.description)} ·{" "}
                {dt("推荐模型：{{model}}", { model: detail.label })}
              </DialogDescription>
            </DialogHeader>
            <img
              src={detail.art}
              alt={dt(detail.description)}
              width={detail.width}
              height={detail.height}
              className="max-h-[55vh] w-full rounded-xl object-contain"
            />
            <p className="text-xs text-muted-foreground">
              {dt("灵感配图 · 非模型实测结果")}
            </p>
            <div className="rounded-xl border bg-muted/30 p-4">
              <h4 className="mb-2 text-sm font-medium">{dt("试试这样描述")}</h4>
              <p className="text-sm leading-7">{dt(detail.prompt)}</p>
            </div>
            <button
              type="button"
              className="inspiration-start justify-center"
              disabled={locked || !eligible(detail)}
              onClick={() => {
                if (onUse(detail)) setDetail(null);
              }}
            >
              {dt(
                eligible(detail)
                  ? "带入创作工作台"
                  : unavailable
                    ? "等待模型目录"
                    : "当前账号不可用",
              )}
              <ArrowRight size={16} />
            </button>
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}
