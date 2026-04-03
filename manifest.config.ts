import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "DuckDuckGo Temp Mail",
  version: "0.1.0",
  description: "DuckDuckGo 临时邮箱与转发邮件聚合插件。",
  action: {
    default_popup: "src/popup/index.html"
  },
  options_page: "src/options/index.html",
  background: {
    service_worker: "src/background/index.ts",
    type: "module"
  },
  permissions: ["storage", "activeTab", "scripting"],
  host_permissions: ["<all_urls>"],
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"]
    }
  ]
});
