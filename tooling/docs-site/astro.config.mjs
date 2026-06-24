import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import fs from "node:fs";

const tutorialSidebar = JSON.parse(
  fs.readFileSync(new URL("../../docs/tutorials/sidebar.json", import.meta.url), "utf8"),
).tutorials;

export default defineConfig({
  integrations: [
    starlight({
      title: "agentOS",
      description: "agentOS documentation",
      sidebar: [
        {
          label: "Start",
          items: [{ label: "Quick Start", link: "/" }],
        },
        {
          label: "Tutorials",
          items: tutorialSidebar,
        },
        {
          label: "Guides",
          items: [{ autogenerate: { directory: "guides" } }],
        },
        {
          label: "Concepts",
          items: [{ autogenerate: { directory: "concepts" } }],
        },
        {
          label: "Reference",
          items: [
            { label: "Runtime Package Map", slug: "runtime-packages" },
            {
              label: "Packages",
              collapsed: true,
              items: [{ autogenerate: { directory: "packages", collapsed: true } }],
            },
            {
              label: "TypeScript Exports",
              collapsed: true,
              items: [{ autogenerate: { directory: "api", collapsed: true } }],
            },
            { label: "Carrier Reference", slug: "reference/carriers" },
            { label: "Boundary Contract", slug: "boundary-contract" },
            { label: "Usage Surfaces", slug: "usage-surfaces" },
          ],
        },
        {
          label: "Operations",
          items: [
            { label: "Internal npm Distribution", slug: "distribution" },
            {
              label: "Release Notes",
              collapsed: true,
              items: [{ autogenerate: { directory: "release-notes", collapsed: true } }],
            },
            { label: "Verification", slug: "verification" },
          ],
        },
      ],
    }),
  ],
});
