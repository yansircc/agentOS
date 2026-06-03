import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform";

export const vibeLikeHttpApi = HttpApi.make("vibe-like-agent-app")
  .add(
    HttpApiGroup.make("runs")
      .add(HttpApiEndpoint.post("createRun", "/runs"))
      .add(HttpApiEndpoint.get("getRun", "/runs/:runId")),
  )
  .add(
    HttpApiGroup.make("workspace")
      .add(HttpApiEndpoint.get("listFiles", "/workspaces/:workspaceId/files"))
      .add(HttpApiEndpoint.get("getProjection", "/workspaces/:workspaceId/projections/:kind")),
  )
  .add(
    HttpApiGroup.make("reference")
      .add(HttpApiEndpoint.get("openapi", "/openapi.json"))
      .add(HttpApiEndpoint.get("scalarReference", "/reference")),
  );

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Vibe-Like Agent App Spike",
    version: "0.0.0-spike",
  },
  paths: {
    "/runs": {
      post: {
        operationId: "createRun",
        responses: { "202": { description: "Run accepted" } },
      },
    },
    "/runs/{runId}": {
      get: {
        operationId: "getRun",
        responses: { "200": { description: "Run projection" } },
      },
    },
    "/workspaces/{workspaceId}/files": {
      get: {
        operationId: "listFiles",
        responses: { "200": { description: "Workspace file projections" } },
      },
    },
    "/workspaces/{workspaceId}/projections/{kind}": {
      get: {
        operationId: "getProjection",
        responses: { "200": { description: "Materialized projection rows" } },
      },
    },
    "/openapi.json": {
      get: {
        operationId: "openapi",
        responses: { "200": { description: "OpenAPI document" } },
      },
    },
    "/reference": {
      get: {
        operationId: "scalarReference",
        responses: { "200": { description: "Scalar API reference" } },
      },
    },
  },
} as const;

export const scalarReferenceHtml = `<!doctype html>
<html>
  <head><title>Vibe-Like Agent App API Reference</title></head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;

export const renderHttpRoute = (path: "/openapi.json" | "/reference") =>
  path === "/openapi.json"
    ? { contentType: "application/json", body: openApiDocument }
    : { contentType: "text/html", body: scalarReferenceHtml };

export const validateOpenApiDocument = (value: typeof openApiDocument): boolean =>
  value.openapi === "3.1.0" &&
  value.paths["/openapi.json"].get.operationId === "openapi" &&
  value.paths["/reference"].get.operationId === "scalarReference";
