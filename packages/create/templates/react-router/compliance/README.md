# compliance/

The **stable texts the project receives and must comply with**: legal texts (a
statute, regulations, policy conditions) and external norms such as a client's brand
or design-system guidelines. They change only by a new, dated version, and the
decisions in [`docs/product/`](../docs/product/README.md) and
[`docs/adr/`](../docs/adr/README.md) may cite them: with `docs/`, this is the only
material a PDR cites ([the spaces ADR](../docs/adr/product-and-reference-spaces.md),
*the rule on sources*).

Raw and intermediate input — functional specs, analyses, prototype exports, legacy
dumps — goes in [`reference/`](../reference/README.md), not here. A design system the
project builds itself is its own code and decisions, not `compliance/`.

## Rules

- **Received, not written.** The project does not edit these texts: a change comes as
  a new version from whoever owns the text. What the project decides about them is a
  PDR or an ADR.
- **Dated at delivery, the new version beside the old.** Stamp each file with the date
  it was received (`YYYY-MM-DD-<name>.docx`); a new version is a new file next to the
  previous one, never written over it, so a decision that cites a version still finds
  it.
- **A text extraction beside each `.docx` or `.pdf`.** The original is the authority;
  the `.md` beside it (`YYYY-MM-DD-<name>.md`) is what gets searched, cited and
  compared when a new version arrives.
- **Quarantined from the toolchain.** Like `reference/`, nothing here is a workspace
  package and Biome ignores it: CI never touches it.
- **An external law not in the repository** is cited by its official link and the
  date of the version a decision rests on. Its text comes in here only when a
  decision depends on its exact wording.

## Contents

List each text as it arrives, so which version holds is never a guess:

| Item | Kind | Received | Notes |
|---|---|---|---|

> This folder ships empty on purpose — fill it with the texts your project answers to.
