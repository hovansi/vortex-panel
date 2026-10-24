# Maintainer release guide

Vortex Panel is published from [hovansi/vortex-panel](https://github.com/hovansi/vortex-panel). The default README is English, with a [Vietnamese overview](README.vi.md). Author attribution is **@hovansi**. Public releases distribute source, installation helpers and documentation; application/server data belongs outside the repository.

## Release contract

The examples below use **0.24.0**. Start publication from the **Release** workflow on `main`, or push a stable `vX.Y.Z` tag after the source and package versions are ready. The release workflow requires `package.json`, both package-lock version fields and the requested tag version to match exactly, and binds publication to the validated commit.

The workflow validates production source on Ubuntu 22.04 and 24.04 before packaging. It creates a draft release, uploads and verifies all four assets, then publishes the draft. An existing draft or published release is an explicit stop condition; the workflow never overwrites assets or automatically replays a failed publication.

| Asset | Purpose |
| --- | --- |
| `vortex-panel-X.Y.Z.zip` | Complete allowlisted source with deterministic archive metadata |
| `install.sh` | Standalone release downloader bound to this repository |
| `release-manifest.json` | Public source inventory and release metadata |
| `SHA256SUMS` | SHA-256 entries for the other three files |

The generic source downloader remains `deploy/bootstrap.sh`. The builder substitutes the repository into the standalone release asset only. The downloaded ZIP contains `deploy/install.sh`, the full installer and its helpers.

## Prepare a version

1. Review the final source diff, public documentation, dependency changes and installation behavior. Bump `package.json` and the top-level/root-package versions in `package-lock.json` together.
2. Run production source and shell syntax checks, build the archive, and inspect its inventory. Validate installation and upgrade behavior separately on an appropriate Ubuntu host.
3. Review the public inventory and every staged path. Keep credentials, `.env` variants, private keys, server data, local output, dependencies, backups and private operational receipts out of Git history and release assets.
4. Build into a new output directory; the builder refuses to overwrite an existing artifact directory.

```bash
npm ci
npm run check
node scripts/release.js --repository hovansi/vortex-panel --output output/release/v0.24.0
```

Build from a clean checkout of the intended commit when comparing local source bytes with CI. `.gitattributes` standardizes text files to LF; the source archive records the bytes actually collected by its builder.

## Publish from GitHub Actions

Upload or commit the reviewed public source on `main`, then:

1. Open the repository's **Actions** tab and choose **Release**.
2. Select **Run workflow**, choose branch **main** and enter **`v0.24.0`** in the tag input.
3. Run the workflow and follow both Ubuntu verification jobs and the publication job.

The verification jobs validate the selected production source commit first. The publisher creates the requested tag only if it is missing and binds it to that same commit. An existing tag must already resolve to the validated commit; a conflicting tag stops publication. A newly created tag is not automatically recreated after an uncertain response.

For later releases, replace `v0.24.0` with the version matching the package files. No local Git identity or manual tag creation is required for this Actions path. Do not pre-create a draft/published release using GitHub's **New release** form: that creates a release object which conflicts with the workflow's existing-release refusal.

### Alternative: push a tag

The workflow also retains its tag-push trigger. After committing the reviewed source, create and push a tag pointing to that exact commit:

```bash
git tag -a v0.24.0 -m "Vortex Panel 0.24.0"
git push origin v0.24.0
```

Choose one trigger for a release. Do not dispatch a second run while a tag-triggered release is active. If a prior run stopped after a mutation, inspect its remote tag/release state before deciding how to continue; publication never silently resumes or overwrites an existing draft.

Protect the default branch and release tags, and enable immutable releases if available. Workflow changes deserve explicit review because their publisher token can write releases. GitHub recommends attaching assets to a draft before publishing an immutable release; see its [release management documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository).

## Observe the publication

The release job verifies local checksums, public repository visibility and the remote tag's commit. Its authenticated preflight checks for **draft and published releases** with the requested tag, using a bounded paginated listing. A 404 from the published-release-by-tag endpoint does not prove that no draft exists. Authentication, rate limits, transport failures, invalid/overlong listings and other unexpected responses stop the job.

After creating a fresh draft, the workflow records its numeric release ID and reads that exact release **by ID**, including while it is still a draft. It checks its identity and uploads four explicit files, recording each acknowledged asset ID. Before publishing, it verifies the uploaded IDs, names, count, size, state and SHA-256 digest against local files, then rechecks the remote tag and release listing. Final verification follows the same release ID after publication. GitHub's [release asset API](https://docs.github.com/en/rest/releases/assets) exposes those identity/digest/state fields.

A partial draft or uncertain publish result needs inspection. The workflow deliberately refuses an existing release; it does not treat a rerun as permission to continue one. Publishing uses the authenticated [REST release](https://docs.github.com/en/rest/releases/releases) and [asset](https://docs.github.com/en/rest/releases/assets) endpoints through [`gh api`](https://cli.github.com/manual/gh_api), so draft inspection and publication stay bound to the acknowledged release ID.

### Inspect a partial publication

Record the existing release ID, tag and validated source commit before taking further action. Inspect the release through its authenticated ID endpoint or the repository's Releases interface; a public tag lookup alone is insufficient for drafts.

Manual completion requires a separate, deliberate verification of that same release: the tag must still name the validated commit, and all four audited artifacts must match their expected names, sizes and SHA-256 digests. Only missing assets from that exact audited build may be added; do not replace an existing asset or move the tag to another commit. Publish the inspected draft only after the complete asset set is verified, then verify its published ID and public downloads.

If any identity or byte comparison fails, stop and preserve the evidence. Correct a published release by preparing a new version/tag instead of replacing its files. Do not blindly delete a draft, overwrite assets or replay an uncertain mutation.

Once publication succeeds, verify the public download from outside the authenticated session. The documented command is:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/hovansi/vortex-panel/releases/latest/download/install.sh | sudo bash
```

The initial script trusts the HTTPS repository publisher. Its subsequent checksum verification does not independently authenticate the bootstrap that is already executing. The [installation guide](INSTALL.md) also documents downloading and reviewing the script first.

## Actions and permissions

CI has read-only repository permissions. The release verification jobs are also read-only; only the publish job receives `contents: write`, with its token scoped to the GitHub CLI publishing step.

| Official action | Reviewed release | Pinned commit |
| --- | --- | --- |
| `actions/checkout` | [v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) | [3d3c42e5aac5ba805825da76410c181273ba90b1](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1) |
| `actions/setup-node` | [v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0) | [949feb2413d6458794dcd2491c4babbbce0c15c1](https://github.com/actions/setup-node/commit/949feb2413d6458794dcd2491c4babbbce0c15c1) |

The actions use Node.js 24 internally and select Node.js 22 for this project's commands. Update action pins through a reviewed change. See GitHub's [secure workflow guidance](https://docs.github.com/en/actions/reference/security/secure-use).
