import garden from "@/assets/media-inspiration/garden.webp";
import aurora from "@/assets/media-inspiration/aurora.webp";
import valley from "@/assets/media-inspiration/valley.webp";

export interface MediaInspiration {
  id: string;
  title: string;
  description: string;
  model: string;
  label: string;
  kind: "image" | "video";
  art: string;
  width: number;
  height: number;
  prompt: string;
}

/** User-supplied artwork. Recommended models are draft targets, not provenance. */
export const MEDIA_INSPIRATION: readonly MediaInspiration[] = [
  {
    id: "garden",
    title: "午后花园",
    description: "绘画 · 光影研究",
    model: "gpt-image-2.5-sunburst",
    label: "Sunburst",
    kind: "image",
    width: 1920,
    height: 1080,
    prompt:
      "地中海花园露台，蓝色门窗与座椅，陶土花盆和繁盛的绣球花，一只白猫卧在阳光斑驳的石阶上，远处是碧蓝海面。暖色墙壁与钴蓝阴影形成对比，细腻厚涂油画，丰富笔触，自然光，无文字、无水印。",
    art: garden,
  },
  {
    id: "aurora",
    title: "极光木屋",
    description: "摄影 · 冬夜光影",
    model: "gpt-image-2.5-flare",
    label: "Flare",
    kind: "image",
    width: 1920,
    height: 1080,
    prompt:
      "雪松森林中的小木屋，窗户透出温暖琥珀色灯光，绿色极光划过深蓝夜空，远处雪山清晰可见。广角电影摄影，细腻积雪与木材纹理，冷暖对比，安静而真实，无文字、无水印。",
    art: aurora,
  },
  {
    id: "valley",
    title: "云端山谷",
    description: "插画 · 自然想象",
    model: "gemini-3.1-flash-image-preview",
    label: "Gemini Flash",
    kind: "image",
    width: 1350,
    height: 2400,
    prompt:
      "竖幅高山湖泊风景，巨大的奶油白积云漂浮在钴蓝天空，雪山环绕碧绿湖水，一只红狐站在前景野花盛开的岩石上眺望远方。富有层次的油画笔触，明亮阳光，辽阔而宁静，无文字、无水印。",
    art: valley,
  },
];
