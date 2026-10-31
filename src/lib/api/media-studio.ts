import { invoke } from "@tauri-apps/api/core";

export interface MediaModel {
  id: string;
  kind: "image" | "video";
  reference: "none" | "optional" | "required";
  sizes: string[];
  durations: number[];
}
export interface MediaRecord {
  id: string;
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
}
export interface MediaRequest {
  operationId: string;
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
  models: () => invoke<MediaModel[]>("get_media_studio_models"),
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
  delete: (id: string) => invoke<void>("delete_media_studio", { id }),
};
