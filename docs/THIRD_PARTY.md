# Third-party data attribution

Vortex Panel reads historical Bedrock Dedicated Server metadata from [EndstoneMC/bedrock-server-data](https://github.com/EndstoneMC/bedrock-server-data), branch `v2`. Download URLs point to Mojang's CDN, and checksum provenance is explicitly community metadata.

The Endstone metadata repository uses the MIT License below. This attribution covers the metadata/identifiers; Minecraft binaries remain subject to Mojang's applicable terms and are not bundled with the panel.

Source: [Endstone LICENSE](https://raw.githubusercontent.com/EndstoneMC/bedrock-server-data/v2/LICENSE), accessed 12 October 2026.

The panel also reads live Linux registry/metadata from [Bedrock-OSS/BDS-Versions](https://github.com/Bedrock-OSS/BDS-Versions), branch `main`. Its root contained no LICENSE file and GitHub reported no recognized license when checked on 12 October 2026 UTC (13 October in Bangkok). No MIT license is claimed for that source, and its corpus or scripts are not bundled with Vortex. Older records may have SHA-1 or no checksum; their provenance remains distinct from Endstone's SHA-256 and Mojang's latest-release API.

```text
MIT License

Copyright (c) 2023 Endstone

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ARM64 Bedrock compatibility runtime

The full ARM64 release installer includes a native ARM64 engine built from [Box64 0.4.4](https://github.com/ptitSeb/box64/tree/2f130fab1d6e1a4ee8a71dc60cfdfcc839ad192a) from the immutable official source archive, checked against SHA-256 `ce844041092de3f44316bd1c033a3cc10024e5f798c1a8e8a58f046c6d967981`. Box64 uses its MIT license. Private x86-64 `libgcc_s` and `libstdc++` files come from that same pinned archive and retain their separate GNU GPL version 3 with GCC Runtime Library Exception 3.1; they are not licensed under Box64's MIT license. The installed runtime includes the Box64 license, GCC license and exception texts, provenance notice and file receipt. The release source ZIP contains the native Box64 engine with its MIT license and verified build manifest. Guest GCC libraries and Minecraft binaries are downloaded during installation/use and are not bundled in the Vortex source ZIP. A maintainer checkout without the generated engine can build the same pinned source locally.

## Node.js dependencies

The source ZIP does not bundle `node_modules`; installation uses `npm ci` and the exact versions/integrity records in `package-lock.json`. The panel's direct npm dependencies—Archiver, Express, Multer, QRCode, ssh2, ws and yauzl—retain their upstream MIT notices. Transitive packages retain their own licenses; Vortex's MIT license does not replace those terms. Keep their license and notice files with any redistributed dependency code.

Some packages omit a `license` metadata field. Inspect their shipped `LICENSE`/`COPYING`/`NOTICE` files instead of treating absent metadata as an absent license. Build and package checks are technical validation; they do not determine distribution rights for third-party code or artwork.
