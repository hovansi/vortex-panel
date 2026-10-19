# Server appearance and Bedrock listing text

[Overview](../README.md) · [Operations](OPERATIONS.md#server-appearance) · [API](API.md#server-appearance)

Open a server workspace and choose **Appearance**. Assigned managers can customize its cover image, icon, description and accent; assigned readers can see the resulting cards and workspace. This works for Minecraft, Node.js and Python servers, including servers on linked VPS nodes.

## Covers, icons and descriptions

Use a square image for the icon and approximately 16:7 for a cover. The preview shows how the selected artwork and accent fit the server card/workspace. Choose **Remove** to clear an uploaded icon or cover. Description and accent use **Save appearance**; image upload/removal commits separately, so closing the editor does not undo an image already saved.

| Field | Limits |
| --- | --- |
| Description | One plain-text line, up to 320 JavaScript string code units; no HTML or control/direction characters |
| Accent | A six-digit hexadecimal color, selected with the color control |
| Icon | PNG/JPEG/WebP, at most 2 MiB and 2048 pixels per side; square recommended |
| Cover | PNG/JPEG/WebP, at most 6 MiB and 4096 pixels per side; 16:7 recommended |
| Image pixels | At most 16,777,216 pixels total |

Images must be non-animated and pass structural validation. Remote image URLs, SVG and HTML are not accepted. Use artwork you have permission to upload; the feature does not generate or grant rights to Minecraft partner logos.

Images are stored privately on the assigned VPS under `DATA_DIR/servers/SERVER_UUID/appearance/`, outside its process-writable `run/` tree. Access uses the server's normal authenticated ACL. Filenames are derived from the image hash rather than the uploaded filename. A successful replacement removes only the previous unreferenced owned image; cleanup warnings preserve the new appearance and require review of the managed folder. The feature bounds leftover image storage rather than accumulating an unlimited upload history.

Edits require the current appearance revision. If another administrator changes the same server's artwork, reload the editor before saving rather than overwriting their newer revision. Panel appearance is metadata/media stored beside the workload; include that directory and `panel.json` in whole-VPS backups. Do not assume a runtime-only world/project backup includes it.

## What Minecraft players see

Vortex's cover, icon and description belong to the panel. The artwork and promotional subtitles in Minecraft's official featured/partner-server list are managed through Minecraft's server program. Uploading artwork to Vortex cannot add that artwork to an ordinary manually added Bedrock server entry. See [Minecraft's official Servers page](https://www.minecraft.net/en-us/servers).

For Bedrock, **Server listing text** edits the actual `server-name` property separately from panel appearance. Stop the server, enter its listing text, use the color/format palette if desired, then choose **Save server listing text**. Start the server to apply it. Panel names and descriptions are independent fields; changing one does not silently replace the others.

The text supports Minecraft `§` formatting codes, for example `§bVortex §fSurvival §7• §aBuild together§r`. The preview approximates colors/formatting and does not guarantee identical rendering on every client/version. Keep it to one line without semicolons or line breaks. Microsoft documents `server-name` as the dedicated server's name and disallows semicolons; see the [official Bedrock server properties](https://learn.microsoft.com/en-us/minecraft/creator/documents/bedrockserver/server-properties?view=minecraft-bedrock-stable).

This feature does not modify Minecraft client files, register a featured-server partnership or install a proxy solely to simulate partner-list artwork.
