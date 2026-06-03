import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

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
          items: [
            { label: "Build a Cloud Agent App", slug: "tutorials/build-cloud-agent-app" },
            { label: "Weather Tool LLM Loop", slug: "tutorials/weather-tool-llm-loop" },
            { label: "Read a Projection", slug: "tutorials/read-a-projection" },
            { label: "Durable Trigger Cancel", slug: "tutorials/durable-trigger-cancel" },
            { label: "Output-Only Attached Stream", slug: "tutorials/output-only-attached-stream" },
            { label: "Streaming Chatbot", slug: "tutorials/streaming-chatbot" },
            { label: "Internal npm Consumer App", slug: "tutorials/internal-npm-consumer-app" },
          ],
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
            { label: "Verification", slug: "verification" },
          ],
        },
      ],
    }),
  ],
});
