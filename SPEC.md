# JLS Installer 0.4 Contract

This document describes the accepted JLS installer behavior for the 0.4 implementation line. It is normative for installer UX, ownership, lifecycle behavior, cross-platform semantics, and release automation.

## Product boundary

JLS installs and manages a curated set of AI coding-agent skills. Skills remain independently versioned and independently released. The installer owns discovery, installation, configuration, updates, uninstallation, installer updates, and installer self-uninstallation; it does not absorb skill behavior into the installer.

The current supported harnesses are OpenAI Codex and Claude Code. Harness-specific paths and filenames are adapter concerns. The user-facing behavior is platform-agnostic.

## Cross-platform invariant

JLS is unapologetically cross-platform across Windows 11+, macOS, and Linux.

The behavioral contract must not be designed as Windows-first or Unix-first. Platform-specific mechanisms are allowed and preferred when they are the native way to provide equivalent semantics and guarantees.

Canonical installer targets are:

```text
windows-x64
windows-arm64
macos-x64
macos-arm64
linux-x64-gnu
linux-arm64-gnu
linux-x64-musl
linux-arm64-musl
```

## Version authority

The repository root `manifest.json` is the installer product and release version authority. `package.json` is not a release manifest.

Implementation and test work for 0.4 must keep the installer manifest at `0.3.2` until explicit release approval. The intended later stable version is `0.4.0`; it must not be applied merely to test the implementation.

A stable release is dispatched only when the manifest `.version` increases to a valid higher semantic version. An unchanged version performs no stable dispatch. A decrease or invalid version fails closed.

## Interactive entry point

Launching the compiled installer without lifecycle arguments opens the interactive installer.

The home screen is exactly:

```text
Manage skills on the current path
Manage skills on the global path
Manage skills on a custom path
Manage installer
```

Custom-path selection uses Clack's built-in path prompt and accepts only an existing directory.

Backspace goes back one immediate meaningful step. At every confirmation, choosing `No` has exactly the same navigation effect as Backspace.

## Scope management

For a scope with no installed skills, JLS goes directly into installation.

For a scope with installed skills, the available actions are:

```text
Install new skills
Check for updates
Uninstall existing skills
```

`Check for updates` and `Uninstall existing skills` are omitted when they are unavailable. They are not rendered as disabled choices.

## Installing skills

The skill picker asks:

```text
Which skills would you like to install?
```

If the selected scope has no detected installations and JLS enters installation directly, it may provide that immediate context before the same question.

Skill descriptions remain visible while the skill is focused. Current catalog presentation includes:

```text
Map
Tasks (Compiles a goal into a taskset using Beads)
```

A skill already installed for every feasible detected harness is crossed out and suffixed:

```text
(already installed)
```

Install-new never silently updates a stale installation. Updating is a separate user action.

### Harness selection

When more than one feasible detected harness exists, the prompt is exactly:

```text
The following supported AI harnesses were detected. You can opt out of any of these if you like.
```

All feasible detected harnesses are selected by default. A single feasible harness may be selected implicitly rather than showing a redundant screen.

### Instruction injection

For selected skills that provide managed instructions, JLS first explains instruction files. The explanation begins:

```text
AI tools can use instruction files to receive extra directions about how they should work in a project.
```

It then identifies the filename used by each selected harness and explains that JLS can add skill instructions without replacing unrelated instructions already present.

The selection prompt is:

```text
The following skills have instructions to inject into your AGENTS.md/CLAUDE.md file. You can opt out of any of these if you like. See above for an explanation of these files.
```

Mechanical filename and singular/plural adaptation is allowed when only one instruction filename is involved.

All capable selected skills are selected for instruction injection by default.

Managed instruction content is bounded by exact JLS ownership markers. Existing unrelated file content is preserved. Ambiguous or malformed JLS marker state fails closed rather than guessing ownership.

Writes use a same-directory temporary file followed by rename/replace semantics. JLS must not deliberately delete the destination first and create an avoidable loss window.

### Install confirmation

The summary begins with the scope-appropriate form of:

```text
JLS Installer will install the following skills on your current path:
```

`current`, `global`, and `custom` are adapted mechanically. The concrete resolved path is displayed. Skill bullets use the actual `•` glyph.

Confirmation is:

```text
Continue?
Yes / No
```

## Updating skills

JLS checks the stable release metadata and only offers skills for which at least one installed harness target is older than the available stable version.

The picker text is exactly:

```text
The following updates are available. Please select which you would like to install.
```

If none are available, JLS uses `prompts.log.info` with exactly:

```text
No updates were found.
```

A selected skill update changes only stale harness targets. A current target is left untouched. A target newer than the stable version is left untouched and must never be downgraded. Unknown/unparseable installed versions are not destructively replaced by the update path merely because another harness target for the same skill is stale.

The update is confirmed before execution.

## Uninstalling skills

The user selects installed skills first.

If a selected skill has detectable generated state beyond its installed files, JLS asks exactly:

```text
The following skills you selected have data generated beyond its installation. If you would like to retain any of this data, deselect the options below before continuing.
```

Detected generated-data cleanup options are selected by default.

Current generated-data descriptions are:

```text
Map: SurrealKV database with surviving intent information from a previous session
Tasks: Beads tasks/issues generated from a goal/intent
```

If no generated data is actually selected for removal, the uninstall confirmation stays flat:

```text
• Map
• Tasks
```

When generated data is actually selected for removal, only relevant skills gain nested detail:

```text
• Skill
  • Skill/agent files: Remove
  • Generated data: Remove
```

A relevant skill whose generated state is being kept may show `Generated data: Keep` when nested detail is already necessary for the transaction.

### Map generated-state ownership

Map-generated state is bounded to the manifest-declared `.map` path. New ownership-aware packages require the exact JLS ownership marker declared by the package. Legacy marker evidence may bridge a missing new ownership marker only when positively identified; an invalid ownership marker always fails closed.

JLS never removes generated paths outside the selected scope.

### Tasks generated-state ownership

Tasks owns only Beads issues newly created by Tasks with exact structured metadata:

```json
{"jls-tasks":"owned"}
```

Existing or reused issues never become Tasks-owned merely because Tasks reads or updates them.

Detection uses the live `bd` CLI and exact metadata filtering:

```text
bd list --metadata-field jls-tasks=owned --json --limit 0
```

JLS verifies returned issue metadata structurally. Titles, descriptions, notes, labels, comments, and prose are never used to infer ownership.

Immediately before deletion JLS re-runs the exact metadata query and deletes only the IDs that still match:

```text
bd delete <id...> --force
```

Deletion may be batched. JLS never deletes `.beads` itself. If `bd` is absent, generated Beads state is preserved. If `bd` is present but cannot safely inspect or delete the exact owned set, cleanup fails closed rather than broadening ownership.

## Execution feedback

Interactive lifecycle subprocess output is captured rather than dumped into the TUI.

Each selected skill receives a spinner for its operation. After the item completes:

- install success uses `prompts.log.success`;
- update success uses `prompts.log.info`;
- uninstall success uses `prompts.log.success`;
- failure uses `prompts.log.error` and stops the transaction safely.

After a successful install or uninstall, final `Done.` uses `prompts.log.success`. After a successful update, final `Done.` uses `prompts.log.info`.

Normal completed interactive operations then render a real Clack `outro` branch.

## Installer management

`Manage installer` offers installer update and installer uninstallation.

### Installer update

If no installer update exists, JLS uses `prompts.log.info` with exactly:

```text
No updates were found.
```

When an update exists, the note is:

```text
An update was found. Would you like to update from v0.2.1 to v0.3.0? If you choose to update, this current session will end. You must relaunch the installer after updating.
```

The versions are dynamic.

The downloaded replacement is SHA-256 verified and staged beside the running executable.

On POSIX, replacing the executable pathname is performed synchronously with same-directory rename semantics and verified before returning.

On Windows, JLS cannot replace its running executable directly. It therefore launches a transient PowerShell finalizer through `cmd.exe /c start "" /b` so the finalizer breaks out of Bun's kill-on-close Job Object. The finalizer:

1. acquires a live handle to the exact JLS parent process before declaring readiness;
2. writes a readiness signal while the parent is still alive;
3. waits on that exact process handle with `WaitForExit()`;
4. atomically replaces the executable using native Windows replace-existing/write-through semantics;
5. verifies the new executable exists and the staged file is gone;
6. reports an explicit diagnostic on failure.

JLS does not use `ping`, `sleep`, blind detached deletion, or an arbitrary time delay to coordinate installer replacement.

A successful installer update intentionally ends the current session; the user relaunches the installer afterward.

### Installer uninstallation

The note is exactly:

```text
This will uninstall the current installer binary file from the location you launched it from and remove installer-owned metadata and tooling. Doing so will immediately end the current session. It will not, however, remove or uninstall any currently installed skills, agent files, agent instruction injections, skill runtimes, or generated data from skills.
```

The semantic contract is:

1. identify the exact running installer with `process.execPath`;
2. remove that exact binary;
3. remove only JLS installer-owned metadata/state/tooling;
4. preserve installed skills, harness resources, managed instruction injections, skill runtimes, and generated skill data;
5. verify filesystem postconditions;
6. report success only after verified cleanup and report an explicit error otherwise.

There is no persistent uninstaller.

On Linux/macOS, the running executable pathname is unlinked synchronously, installer-owned state is removed, and both results are verified before success is rendered.

On Windows, a transient PowerShell finalizer is launched through the same Bun Job Object breakaway mechanism used for installer replacement. Before the parent exits, the finalizer acquires the exact live parent process and signals readiness. It then waits on that process handle with `WaitForExit()`. After the parent terminates it deletes the exact executable and installer-owned state and verifies both postconditions.

Because only the Windows finalizer can know whether post-parent deletion succeeded, it owns the final Windows success/error rendering. The parent must not claim success prematurely.

No `ping`, `sleep`, arbitrary timer, or blind detached deletion is used for installer self-uninstallation.

## Package model

Installation remains manifest-driven.

A package may declare:

- name/version/description;
- skill files;
- harness-specific resources;
- runtime kind/artifacts/support files;
- runtime CLI/token;
- managed instruction fragment;
- path-owned generated data;
- bounded non-path generated cleanup semantics.

Unknown future fields may be ignored only where doing so is safe. New cleanup semantics must never be represented as an unsafe fake filesystem path for backward compatibility.

Downloaded package archives are hash-verified before extraction. Package-declared paths are containment-validated. Installer-owned runtime and generated-data paths use explicit ownership evidence before destructive replacement or cleanup.

## Release model

JLS builds only the installer. Skill repositories own their skill packages and runtime builds.

The JLS stable release manifest references externally owned skill release manifests. Artifact selection is exact current target first, then an explicit `portable` fallback for skills only.

Public installer filenames remain target-qualified. Tasks publishes its portable package as `tasks.zip`.

Stable releases are version-gated by each repository's manifest version. Ordinary source edits may run lightweight version checks but must not create a new stable release when the version is unchanged.

## Test-build trigger

Normal implementation pushes must not build every installer target merely to obtain a test signal.

A lightweight workflow listens for creation of an ephemeral branch matching:

```text
jls-test/**
```

For JLS, it dispatches the existing non-release installer build from `main` and then deletes the trigger branch.

For Map, the test trigger dispatches the single `linux-x64-gnu` non-release target. Stable and nightly Map releases still build the complete supported target matrix.

The intended assistant workflow is:

1. complete and commit implementation work;
2. create one `jls-test/<unique>` branch at the exact final `main` commit;
3. report that the test build was triggered;
4. do not wait for or poll the build result unless the user reports a failure or explicitly asks for inspection.

No manifest version bump is required for a test build.

## 0.4 release boundary

The implementation target is JLS 0.4.0, but implementation/testing must not change the installer manifest from `0.3.2` until explicit release approval.

Map remains `0.4.0` and Tasks remains `0.2.0` until the user explicitly decides their next release versions. Do not invent replacement version numbers merely to publish source changes.

Before the JLS 0.4 stable release, the skill release manifests referenced by JLS must correspond to skill packages that actually contain the source-level contracts intended for that release. A source commit existing after an older same-version stable package does not make that older package magically contain the newer behavior.
