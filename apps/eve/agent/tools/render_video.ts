import { defineTool } from "eve/tools";

import { RenderVideoInput, renderVideoEffect } from "../lib/effect/remotion";
import { runTool } from "../lib/effect/runtime";
import { toolSchema } from "../lib/effect/tool-schema";

export default defineTool({
  description: `Render an MP4 video from a Remotion (React) composition and get a shareable URL. You author the video as code: provide TSX that default-exports a React component, and it is rendered frame by frame at the given size and frame rate.

Authoring rules:
- Import only from "remotion" and "react". Animate with useCurrentFrame(), interpolate(), spring(); lay out with <AbsoluteFill>; sequence scenes with <Sequence from={n} durationInFrames={m}>; embed media with <Img src>, <Video src>, <Audio src> (publicly reachable URLs only).
- Style with inline styles. System fonts only (e.g. fontFamily: "Helvetica, Arial, sans-serif").
- Example skeleton:
  import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
  export default function Video() {
    const frame = useCurrentFrame();
    const opacity = interpolate(frame, [0, 30], [0, 1]);
    return <AbsoluteFill style={{ backgroundColor: "#0b1020", justifyContent: "center", alignItems: "center" }}>
      <h1 style={{ color: "white", fontSize: 120, opacity }}>Hello</h1>
    </AbsoluteFill>;
  }

Rendering takes roughly 15-90 seconds. The result includes a url - always give it to the user as a markdown link. A "local" storage url is relative to this app's origin (works in web chat).`,
  inputSchema: toolSchema(RenderVideoInput),
  execute(input) {
    return runTool(renderVideoEffect(input));
  },
});
