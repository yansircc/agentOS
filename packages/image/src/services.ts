import { Context, Data } from "effect";

/** Minimal `env.AI.run` shape consumed by the CF AI image adapter. */
export interface ImageAi {
  readonly run: (model: string, input: unknown, options?: unknown) => Promise<unknown>;
}

export class ImageAiBinding extends Context.Tag("@agent-os/image/ImageAiBinding")<
  ImageAiBinding,
  ImageAi
>() {}

export class ImageUpstreamFailure extends Data.TaggedError("agent_os.image_upstream_failure")<{
  readonly cause: unknown;
}> {}

export class ImageDecodeFailure extends Data.TaggedError("agent_os.image_decode_failure")<{
  readonly reason: string;
}> {}
