import sunroom from "@/assets/media-inspiration/sunlit-arch.svg";
import moonlake from "@/assets/media-inspiration/moonlake.svg";
import botanical from "@/assets/media-inspiration/botanical.svg";
import dunes from "@/assets/media-inspiration/dunes.svg";

export interface MediaInspiration {
  id: string;
  title: string;
  description: string;
  model: string;
  label: string;
  kind: "image" | "video";
  art: string;
  prompt: string;
}

/** Original bundled illustrations, not outputs of the named models. No network assets. */
export const MEDIA_INSPIRATION: readonly MediaInspiration[] = [
  {
    id: "sunroom",
    title: "让光，成为主角。",
    description: "暖调空间 · 建筑与生活方式",
    model: "gpt-image-2.5-sunburst",
    label: "Sunburst",
    kind: "image",
    art: sunroom,
    prompt:
      "一间面向沙漠的极简建筑，拱形门洞、陶土花瓶与橄榄枝，午后阳光在浅色地面投下长长的影子。暖赭石与奶油色调，安静、通透，建筑摄影构图，细腻材质，无文字、无水印。",
  },
  {
    id: "botanical",
    title: "日常，也有诗意。",
    description: "植物静物 · 自然材质与色彩",
    model: "gpt-image-2.5-flare",
    label: "Flare",
    kind: "image",
    art: botanical,
    prompt:
      "奶油色墙面前的一只手作陶罐，舒展的绿叶与一颗橙子构成自然静物。侧面柔光，鼠尾草绿与陶土棕，保留陶器纹理，画面简洁、富有呼吸感，杂志内页风格，无文字、无水印。",
  },
  {
    id: "moonlake",
    title: "驶向想象的边界。",
    description: "氛围插画 · 山、月与一叶帆船",
    model: "gemini-3.1-flash-image-preview",
    label: "Gemini Flash",
    kind: "image",
    art: moonlake,
    prompt:
      "蓝绿色暮色中的高山湖泊，层叠山脉、细小星光和一弯新月，一叶米白色帆船漂在平静水面。大面积留白，远近层次清晰，诗意旅行海报构图，细腻纸张与绘画质感，无文字、无水印。",
  },
  {
    id: "dunes",
    title: "让静止的灵感，流动起来。",
    description: "镜头灵感 · 日落沙丘",
    model: "muse-video",
    label: "Muse",
    kind: "video",
    art: dunes,
    prompt:
      "日落时分的连绵沙丘，远处一位旅人沿沙脊缓缓行走。镜头平稳向前推进，细沙被微风轻轻吹起，暖金色光线逐渐过渡到蓝调阴影。保持主体和地形连续，电影感自然光，无文字、无水印。",
  },
];
