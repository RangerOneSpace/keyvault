# Package hallucination reference data

`slopsquatting.jsonl` is a pinned copy of the dataset published by Trend Micro for its research on hallucinated AI-generated dependencies.

- Source: https://github.com/trendmicro/slopsquatting
- Pinned commit: `92cc9f6ad9aa77daae858865c1df1edaa67df8ab`
- Source file: `slopsquatting.jsonl`
- SHA-256: `54e487fbe4fea9feffa6b6660c5e23a6ed58fd7b5539db981a545d5347dced74`
- License: MIT; see [slopsquatting-LICENSE.MD](./slopsquatting-LICENSE.MD)

The snapshot contains 1,400 research records. Its `modulenotfound` values are Python module identifiers and are used as a deny signal after Python package-name normalization. The dataset has no package-ecosystem field and does not establish that a name is a PyPI distribution name. A match hard-blocks that exact normalized name. If the candidate was an import identifier, identify its distinct canonical distribution name and verify that separately; never override the matched name. A non-match is not a safety verdict. This corpus does not cover npm or other ecosystems.

Update this snapshot only from a reviewed immutable upstream commit. Verify the file hash, inspect schema and license changes, update the pinned metadata and tests, then review the resulting diff. Never install packages from the dataset.
