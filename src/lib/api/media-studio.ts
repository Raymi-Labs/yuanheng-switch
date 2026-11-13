import { invoke } from "@tauri-apps/api/core";
import type { YuanhengGroupOption } from "./yuanheng";

export interface MediaGroups {
  groups: YuanhengGroupOption[];
  selectedGroup: string | null;
  unverifiedGroupCount?: number;
  modelsByGroup?: Record<string, MediaModel[]>;
  selectedGroups?: Partial<Record<"image" | "video", string | null>>;
}

export interface MediaModel {
  id: string;
  kind: "image" | "video";
  reference: "none" | "optional" | "required";
  sizes: string[];
  durations: number[];
  qualities?: string[];
  resolutions?: string[];
  outputFormats?: string[];
  backgrounds?: string[];
  customSize?: boolean;
}
export interface MediaDraft {
  size: string;
  duration: number | null;
  quality?: string;
  resolution?: string;
  outputFormat?: string;
  background?: string;
  outputCompression?: number;
  prompt?: string;
  needsReference?: boolean;
}
export interface MediaRecord {
  id: string;
  group?: string;
  model: string;
  kind: "image" | "video";
  status:
    | "submitting"
    | "unknown"
    | "queued"
    | "in_progress"
    | "completed"
    | "failed";
  createdAt: number;
  taskId: string | null;
  message: string;
  hasMedia: boolean;
  draft?: MediaDraft;
}
export interface MediaRequest extends Omit<MediaDraft, "prompt"> {
  savePrompt?: boolean;
  operationId: string;
  group: string;
  model: string;
  prompt: string;
  size: string;
  duration: number | null;
  reference: string | null;
  images?: string[];
}
export const mediaStudioApi = {
  saveDialog: (
    defaultName: string,
    extension: "mp4" | "png" | "jpg" | "webp",
  ) =>
    invoke<string | null>("save_media_file_dialog", { defaultName, extension }),
  groups: () => invoke<MediaGroups>("get_media_studio_groups"),
  selectGroup: (group: string, kind?: "image" | "video") =>
    invoke<string>("set_media_studio_group", {
      group,
      ...(kind ? { kind } : {}),
    }),
  models: (group: string) =>
    invoke<MediaModel[]>("get_media_studio_models", { group }),
  history: () => invoke<MediaRecord[]>("get_media_studio_history"),
  submit: (request: MediaRequest) =>
    invoke<MediaRecord>("submit_media_studio", { request }),
  refresh: (id: string) => invoke<MediaRecord>("refresh_media_studio", { id }),
  preview: (id: string) =>
    invoke<{ data: string; mime: string }>("preview_media_studio", { id }),
  prepareVideoReference: (id: string) =>
    invoke<{ data: string; mime: string }>("prepare_media_video_reference", {
      id,
    }),
  export: (id: string, path: string) =>
    invoke<void>("export_media_studio", { id, path }),
  forgetPrompt: (id: string) =>
    invoke<void>("forget_media_studio_prompt", { id }),
  delete: (id: string) => invoke<void>("delete_media_studio", { id }),
};
