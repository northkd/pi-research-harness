# AI image generation

html-ppt supports AI image generation as an offline asset workflow. It never calls image APIs from browser runtime, and API keys must never be placed in HTML.

## When To Use

Use AI generation for image assets that are hard to draw directly:

- Cover or section backgrounds
- Atmospheric illustrations
- Photography-like scenes
- Decorative textures or patterns
- Concept visuals without precise labels

Do not use AI image generation for charts, architecture diagrams, flow diagrams, or anything requiring exact labels. Those should be authored in HTML/SVG/CSS.

## Directory Layout

Each deck owns its generated assets:

```text
examples/my-talk/
├── index.html
└── images/
    ├── image_manifest.json
    ├── image_prompts.md
    ├── placeholders/
    │   └── cover_bg.svg
    └── generated/
        └── cover_bg.png
```

Initialize a deck:

```bash
python3 scripts/image_assets.py init examples/my-talk
```

## Manifest

Declare image needs in `images/image_manifest.json`:

```json
{
  "version": 1,
  "deck": "my-talk",
  "assets": [
    {
      "id": "cover_bg",
      "filename": "cover_bg.png",
      "placeholder": "placeholders/cover_bg.svg",
      "final_path": "generated/cover_bg.png",
      "dimensions": "1920x1080",
      "aspect_ratio": "16:9",
      "type": "Background",
      "purpose": "Cover background",
      "status": "pending",
      "prompt": "Abstract academic blue presentation background, subtle paper texture, clean negative space for title, 16:9, high quality",
      "negative_prompt": "text, watermark, faces, busy pattern, low quality",
      "alt": "Abstract blue academic background"
    }
  ]
}
```

## Prompt-Only Workflow

Use this when no image API is configured:

```bash
python3 scripts/image_assets.py placeholder examples/my-talk
python3 scripts/image_assets.py verify examples/my-talk
```

This creates `images/image_prompts.md` and SVG placeholders in `images/placeholders/`.

In the first round, paste the full prompts into the final response and ask the user to generate images manually. The user should place final image files in `images/generated/` using the manifest filenames.

In the second round, after the user says the images are ready:

```bash
python3 scripts/image_assets.py verify examples/my-talk
```

If all files exist, replace placeholder references such as:

```html
images/placeholders/cover_bg.svg
```

with:

```html
images/generated/cover_bg.png
```

Then render or preview the deck.

## API Workflow

Configure `.env` at the repository root:

```bash
IMAGE_BACKEND=gemini
GEMINI_API_KEY=your-key
```

Supported core backends:

- `gemini`
- `openai`
- `qwen`
- `zhipu`
- `volcengine`

List backends:

```bash
python3 scripts/image_gen.py --list-backends
```

Generate one image:

```bash
python3 scripts/image_gen.py \
  "Abstract academic blue presentation background, clean negative space, 16:9" \
  --aspect_ratio 16:9 \
  --image_size 1K \
  -o examples/my-talk/images/generated \
  --filename cover_bg
```

Use provider-specific variables only. These global keys are intentionally unsupported:

- `IMAGE_API_KEY`
- `IMAGE_MODEL`
- `IMAGE_BASE_URL`

## First-Round Response Rule

When a deck needs AI-generated images but no API key is available, the agent must:

- Save `images/image_manifest.json`
- Save `images/image_prompts.md`
- Generate SVG placeholders
- Make the deck reference placeholders
- Paste all prompts in the response
- Tell the user to put finished images under `images/generated/`

Do not block deck preview on missing AI images.
