import { useState } from "react";
import { ArrowDown, ArrowRight, ImageIcon, Play, Sparkles } from "lucide-react";
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
          <p className="inspiration-eyebrow">
            <span /> META API · CREATIVE STUDIO
          </p>
          <h2>{dt("给想象，一个画面。")}</h2>
          <p className="inspiration-lede">
            {dt("从一束光、一抹色彩开始。找到灵感，再用自己的语言创作。")}
          </p>
        </div>
        <button className="inspiration-start" type="button" onClick={onCreate}>
          <Sparkles size={16} />
          {dt("自由创作")}
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
        <span className="inspiration-caption">
          <ArrowDown size={13} /> {dt("选一个方向，开始你的作品")}
        </span>
      </div>
      <div
        className={`inspiration-grid ${filter !== "all" ? "inspiration-grid-filtered" : ""}`}
      >
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
                loading={index === 0 ? "eager" : "lazy"}
                width="1200"
                height="900"
              />
              <div className="inspiration-shade" />
              <div className="inspiration-cover-top">
                <span>
                  {item.kind === "video" ? (
                    <Play size={13} />
                  ) : (
                    <ImageIcon size={13} />
                  )}
                  {dt(item.kind === "video" ? "镜头灵感" : "图像创作")}
                </span>
                <span>META API</span>
              </div>
              <div className="inspiration-cover-bottom">
                <span className="inspiration-number">
                  0{MEDIA_INSPIRATION.indexOf(item) + 1} / {dt("灵感系列")}
                </span>
                <h3>{dt(item.title)}</h3>
                <span className="inspiration-line" />
              </div>
              {item.kind === "video" && (
                <span className="inspiration-play" aria-hidden="true">
                  <Play size={25} fill="currentColor" />
                </span>
              )}
            </button>
            <div className="inspiration-card-footer">
              <div>
                <span className="inspiration-model-label">{item.label}</span>
                <p className="inspiration-model-id">{item.model}</p>
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
                    ? "使用灵感"
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
      <footer className="inspiration-disclosure">
        <span>✳</span>
        <p>
          {dt(
            "配图为原创灵感插画，非对应模型的实测结果。使用灵感仅填入草稿，点击生成后才提交计费。",
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
                {dt(detail.description)} · {detail.label}
              </DialogDescription>
            </DialogHeader>
            <img
              src={detail.art}
              alt={dt(detail.description)}
              className="max-h-72 w-full rounded-xl object-cover"
            />
            <p className="text-xs text-muted-foreground">
              {dt("原创灵感插画 · 非模型实测结果")}
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
