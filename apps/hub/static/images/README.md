# Extension artwork

`logo.png`, `logo-large.png`, `hub-light.png` and `hub-dark.png` are
**generated placeholders**, not designed artwork. They are here so that
`tfx extension create` produces a valid `.vsix` and the hub renders an icon
rather than a broken image.

Replace them before publishing to the Marketplace:

| File             | Size       | Used for                               |
| ---------------- | ---------- | -------------------------------------- |
| `logo.png`       | 128×128    | Extension icon                         |
| `logo-large.png` | 512×512    | Marketplace listing                    |
| `hub-light.png`  | 32×32 RGBA | Hub nav icon, light theme (dark glyph) |
| `hub-dark.png`   | 32×32 RGBA | Hub nav icon, dark theme (light glyph) |

The hub icons need transparency and must read at 16px, so keep them to a
single-colour silhouette.
