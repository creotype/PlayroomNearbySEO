# Playroom article hero image guide

Prompt version: `playroom-hero-v2-leo`

Every newly generated article has one landscape editorial illustration starring Leo, the Playroom mascot. The two canonical reference images in `assets/mascot/leo/` are always passed to GPT Image as identity references; they are not edit targets or composition templates.

## Leo character bible

- Exactly one Leo is the main character in every image.
- Preserve his golden-yellow fur, rounded cub proportions, symmetrical petal-shaped orange mane, large dark-brown eyes, warm-brown eyebrows, rounded ears with orange inner ears, small dark nose, pale cream muzzle, cheek whisker marks, orange tail tuft and friendly expression.
- Preserve the dark navy hoodie with hood down, white drawstrings, kangaroo pocket, ribbed cuffs and hem, plus the small orange map-pin emblem with a navy heart on his chest. Keep his golden legs and paws bare: no trousers and no shoes. The chest emblem is the only permitted brand mark.
- Match the polished softly modelled 3D mascot style and tactile fur/fabric textures shown in the canonical references.
- Adapt Leo's pose, expression, action and props to the article topic. Do not mechanically copy the white reference background, map or pose. Graphics printed on the reference map are incidental prop details and must never be copied; only Leo's chest emblem is canonical.
- Never redesign Leo as a human, realistic animal, flat icon, different lion or generic mascot. Never duplicate him or add another lion mascot.

## Visual language

- Warm, optimistic, premium editorial illustration for parents and children.
- Dominant orange/yellow palette: tangerine, amber, sunflower, warm cream and soft golden light.
- Leo's hoodie always remains dark navy. Elsewhere, muted navy, teal or warm brown are supporting colours only; orange and yellow remain dominant.
- Leo remains the recognisable 3D focal character; the surrounding scene may combine layered paper-cut forms with softly modelled 3D shapes, rounded geometry, tactile materials and gentle depth.
- One clear topic-specific focal scene with Leo actively participating; avoid generic playground stock imagery.
- Landscape composition with breathing room around the focal subject, suitable for a website hero crop.
- Friendly and trustworthy rather than infantile, chaotic or overly saturated.

## Hard constraints

- Do not render words, letters, numbers, captions, signs, other logos, other brands or watermarks.
- Leo's face must be visible and consistent. Do not show identifiable human faces. When people add useful context, show them from behind, at a distance, as simplified silhouettes, or crop above/below the face.
- No real venue identity, address, price, certification, rating, or other unsupported claim.
- No photorealistic identifiable child, celebrity or public figure.
- No unsafe activity, injury, fear, weapons, alcohol, tobacco or adult themes.
- Produce exactly one image with one Leo; no collage, split screen, border or mockup frame.

The runtime appends the article title, subject, primary keyword and short summary to this fixed guide. The ordered SHA-256 fingerprint of the canonical reference set is part of the cache key. Changes to the guide or references require a new prompt-version constant so cached assets stay reproducible.
