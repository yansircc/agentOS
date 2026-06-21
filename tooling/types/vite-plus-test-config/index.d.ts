import type { TestUserConfig } from "vite-plus/test/config";

declare module "vite-plus" {
  interface UserConfig {
    readonly test?: TestUserConfig;
  }
}
