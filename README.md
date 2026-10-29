# Hangline: a 3D clothing rail for Shopify

Hangline is a demo streetwear store that shows how far you can push a standard Shopify theme. The homepage replaces the usual product grid with a real-time 3D clothing rail: shoppers drag or scroll along the rail, garments swing on their hangers, and clicking a piece brings it forward with a Front/Back view, size picker and add to cart. Cart and checkout stay native Shopify.

It is built on [Dawn](https://github.com/Shopify/dawn) with one self-contained section, so it drops into any Online Store 2.0 theme.

## What's custom

| File | Purpose |
|---|---|
| `sections/scene-rail.liquid` | The section: theme editor settings, product data as JSON, the detail panel, and a crawlable fallback grid |
| `assets/scene-rail.js` | The `<scene-rail>` custom element: Three.js scene, hanger physics, drag/scroll/keyboard input, detail panel and AJAX cart |
| `assets/section-scene-rail.css` | Section styles, including the mobile layout |
| `assets/three.module.min.js` | Three.js r170, loaded through an import map (no build step) |
| `templates/index.json`, `templates/page.scene-rail.json` | The rail on the homepage and as a standalone page template |

## How it works

- **Products come from Shopify.** The section reads a collection chosen in the theme editor. Each product's first image is the front view, the second is the back view, and a variant option called `Size` becomes the size picker.
- **Photos become cut-outs in the browser.** Product shots on a plain studio background are cut out at load time with a gradient-tolerant flood fill from the image border, then used as textures on planes in the scene. A blurred copy of each silhouette becomes its drop shadow. No 3D models or manual masking are needed.
- **Hangers swing with real physics.** Each garment is a damped spring around its hook, pushed by how fast the rail is moving, plus a small idle sway.
- **Clicks are pixel-accurate.** Pointer hits are checked against the cut-out's alpha, so clicking the empty space around a garment doesn't select it.
- **Native cart.** Add to cart uses the Cart AJAX API with Section Rendering, then opens Dawn's cart drawer with the updated contents.
- **Accessible and resilient.** Arrow keys browse, Enter opens and Escape closes. Visitors with reduced motion or no WebGL get a normal product grid, which is also in the HTML for search engines. Rendering pauses when the section is off screen.

## Theme editor settings

Collection, number of products, eyebrow, heading, hint text, stage height, background and text colour.

## Local development

```bash
npm install -g @shopify/cli
shopify theme dev --store <your-store>.myshopify.com
```

To use the rail on another theme, copy the three asset files and the section, then add the section to a template from the theme editor.

## Credits

Built by [arifhossainux02](https://github.com/arifhossainux02). Based on Shopify's Dawn theme (MIT). Demo product photography is AI-generated.
