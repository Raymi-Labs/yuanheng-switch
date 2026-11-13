import { invoke } from "@tauri-apps/api/core";

export interface CommerceBundle {
  root: string;
  work: string;
}
export interface CommerceReport {
  passed: boolean;
  errors: string[];
  productCount: number;
  requiresHumanReview: boolean;
  nativeExecutionVerified: boolean;
  baselineSaved: boolean;
}
export const accioCommerceApi = {
  prepare: (parent: string) =>
    invoke<CommerceBundle>("prepare_accio_commerce", { parent }),
  check: (root: string, action: "draft" | "snapshot" | "revision") =>
    invoke<CommerceReport>("check_accio_commerce", { root, action }),
};
