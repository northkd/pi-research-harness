import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

interface ImageGenDetails {
  model: string;
  quality: string;
  size: string;
  prompt: string;
  outputPath?: string;
  success: boolean;
  error?: string;
}

const ImageParams = Type.Object({
  prompt: Type.String({ description: "Detailed description of the image to generate" }),
  model: Type.Optional(
    Type.Union([
      Type.Literal("gpt-image-2.5"),
      Type.Literal("gpt-image-2.5-flare"),
      Type.Literal("gpt-image-2.5-sunburst"),
    ], { description: "Model variant: flare (speed/draft), sunburst (quality/detail), or 2.5 (balanced default)" })
  ),
  quality: Type.Optional(
    Type.Union([
      Type.Literal("low"),
      Type.Literal("standard"),
      Type.Literal("high"),
      Type.Literal("xhigh"),
      Type.Literal("max"),
    ], { description: "Sampling and rendering precision (e.g. low for fast draft, high/max for fine detail and complex lighting)" })
  ),
  size: Type.Optional(
    Type.Union([
      Type.Literal("1024x1024"),
      Type.Literal("1254x1254"),
      Type.Literal("1792x1024"),
      Type.Literal("1024x1792"),
    ], { description: "Image resolution" })
  ),
  background: Type.Optional(
    Type.Union([
      Type.Literal("opaque"),
      Type.Literal("transparent"),
    ], { description: "Background transparency (opaque or transparent for icons/assets)" })
  ),
  outputPath: Type.Optional(
    Type.String({ description: "Local file path to save the generated PNG (e.g. ./output.png)" })
  ),
});

export default function imageGenerationExtension(pi: ExtensionAPI) {
  const API_BASE = process.env.CLIPROXY_BASE_URL || "http://127.0.0.1:8317";
  const API_KEY = process.env.CLIPROXY_API_KEY;

  if (!API_KEY) {
    throw new Error("Set CLIPROXY_API_KEY before enabling the optional image extension");
  }

  // Register generate_image tool for Pi
  pi.registerTool({
    name: "generate_image",
    label: "Generate Image",
    description: "Generate images using GPT Image 2.5 (flare for speed, sunburst for high fidelity/detail, 2.5 for balanced). Adjust sampling and rendering precision with the 'quality' parameter.",
    parameters: ImageParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const model = params.model || "gpt-image-2.5";
      const quality = params.quality || (model === "gpt-image-2.5-flare" ? "low" : model === "gpt-image-2.5-sunburst" ? "high" : "standard");
      const size = params.size || "1024x1024";
      const background = params.background || "opaque";

      try {
        const response = await fetch(`${API_BASE}/v1/images/generations`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            prompt: params.prompt,
            n: 1,
            size,
            quality,
            background,
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          return {
            content: [{ type: "text", text: `Image generation failed (HTTP ${response.status}): ${errText}` }],
            details: { model, quality, size, prompt: params.prompt, success: false, error: errText } as ImageGenDetails,
          };
        }

        const data = (await response.json()) as any;
        const b64Data = data.data?.[0]?.b64_json;
        if (!b64Data) {
          return {
            content: [{ type: "text", text: `Error: No image data returned from ${model}` }],
            details: { model, quality, size, prompt: params.prompt, success: false, error: "No b64_json data" } as ImageGenDetails,
          };
        }

        const buffer = Buffer.from(b64Data, "base64");
        let savePath = params.outputPath;
        if (!savePath) {
          const dir = path.join(process.cwd(), "generated_images");
          fs.mkdirSync(dir, { recursive: true });
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          savePath = path.join(dir, `image_${model}_${quality}_${timestamp}.png`);
        } else {
          const dir = path.dirname(path.resolve(savePath));
          fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(savePath, buffer);

        return {
          content: [
            {
              type: "text",
              text: `Successfully generated image with ${model} (quality: ${quality}, size: ${size}, background: ${background}).\nSaved to: ${savePath}`,
            },
          ],
          details: {
            model,
            quality,
            size,
            prompt: params.prompt,
            outputPath: savePath,
            success: true,
          } as ImageGenDetails,
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Image generation exception: ${err.message}` }],
          details: { model, quality, size, prompt: params.prompt, success: false, error: err.message } as ImageGenDetails,
        };
      }
    },
  });

  // Register /image slash command for user convenience
  pi.registerCommand("image", {
    description: "Generate an image via GPT Image 2.5: /image <prompt> [--model flare|sunburst] [--quality low|standard|high|max]",
    handler: async (args, ctx) => {
      if (!args || !args.trim()) {
        ctx.ui.notify("Usage: /image <prompt> [--model flare|sunburst] [--quality low|high|max]", "error");
        return;
      }

      let model = "gpt-image-2.5";
      let quality = "standard";
      let prompt = args;

      if (prompt.includes("--model flare")) {
        model = "gpt-image-2.5-flare";
        prompt = prompt.replace("--model flare", "").trim();
      } else if (prompt.includes("--model sunburst")) {
        model = "gpt-image-2.5-sunburst";
        prompt = prompt.replace("--model sunburst", "").trim();
      }

      if (prompt.includes("--quality low")) {
        quality = "low";
        prompt = prompt.replace("--quality low", "").trim();
      } else if (prompt.includes("--quality high")) {
        quality = "high";
        prompt = prompt.replace("--quality high", "").trim();
      } else if (prompt.includes("--quality max")) {
        quality = "max";
        prompt = prompt.replace("--quality max", "").trim();
      }

      ctx.ui.notify(`Generating image with ${model} (quality: ${quality})...`, "info");

      try {
        const response = await fetch(`${API_BASE}/v1/images/generations`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            prompt,
            n: 1,
            size: "1024x1024",
            quality,
          }),
        });

        if (!response.ok) {
          const err = await response.text();
          ctx.ui.notify(`Generation failed: ${err}`, "error");
          return;
        }

        const data = (await response.json()) as any;
        const b64Data = data.data?.[0]?.b64_json;
        if (!b64Data) {
          ctx.ui.notify("No image returned from server", "error");
          return;
        }

        const dir = path.join(process.cwd(), "generated_images");
        fs.mkdirSync(dir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const savePath = path.join(dir, `image_${model}_${quality}_${timestamp}.png`);
        fs.writeFileSync(savePath, Buffer.from(b64Data, "base64"));

        ctx.ui.notify(`Image generated and saved to: ${savePath}`, "info");
      } catch (e: any) {
        ctx.ui.notify(`Error: ${e.message}`, "error");
      }
    },
  });
}
