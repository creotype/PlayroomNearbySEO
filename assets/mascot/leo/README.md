# Leo runtime references

These two images are the ordered identity references for article hero generation:

1. `leo-reference-primary.png` — canonical full-body identity reference.
   SHA-256: `67444c2db8613c218e2503fa91f496aba39ca326abb94a73d8513d608d5a7ffa`
2. `leo-reference-map.png` — secondary identity and natural-action reference.
   SHA-256: `43575a274b6e35e16278a8641167f21999fd480d11debfec75f7c5dd8b25fe1c`

The runtime loads them in this exact order, validates their image signatures, and includes an ordered content fingerprint in the durable hero-image cache key. They are identity references, not edit targets or fixed composition templates.

Do not replace, reorder, add, or remove runtime references without also updating the character bible in `prompts/HERO_IMAGE_GUIDE.md` and incrementing `HERO_IMAGE_PROMPT_VERSION`.
