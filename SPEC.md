# JLS Installer

Status: accepted lifecycle contract for the 0.4 installer redesign.

JLS is the installer, updater, uninstaller, and lifecycle utility for the JLS skill catalog. Skill source/runtime/package behavior lives in each skill repository. JLS owns scope selection, harness placement, managed instruction integration, update discovery, bounded generated-data cleanup, and installer self-management.

## Supported harnesses

Initial supported harnesses:

- OpenAI Codex
- Claude Code

Harness adapters own detection, skill locations, instruction files, and harness-specific resource paths.

Detection is internal. Interactive installation presents only detected supported harnesses. Explicit deterministic `--agent` values remain allowed.

## Public CLI

```text
jls install [skills...] [--scope user|cwd|PATH] [--agent AGENT]... [--instructions|--no-instructions]
jls update [skills...] [--scope user|cwd|PATH] [--agent AGENT]... [--instructions|--no-instructions]
jls uninstall [skills...] [--scope user|cwd|PATH] [--agent AGENT]...
```

A skill-first invocation may continue to mean install.

`--scope` accepts:

```text
user
cwd
PATH
```

Interactive simplification must not remove deterministic custom-path support.

## Scope invariant

Scope and harness are orthogonal.

- `cwd` targets only the invocation working directory.
- `user` targets only the user/global scope.
- an explicit path targets only that canonicalized path.

A detected machine-level harness never authorizes installation into another scope.

Skill runtime/tooling is scope-local:

```text
user scope       ~/.jls/<skill>/
project/custom   <scope>/.jls/<skill>/
```

Do not widen, relocate, or duplicate a requested scope.

## Path normalization

Custom paths support `~`, supported environment variables, relative components, `.`/`..`, Windows separator/casing normalization, and existing filesystem casing where safely available.

Empty custom-path submission is a validation error, not an exception.

## Installation discovery

There is no authoritative central install receipt registry.

The selected scope's supported harness locations are authoritative for installed-skill discovery. A managed installation requires a valid installed `manifest.json` whose `name` matches its catalog/discovery identity.

`SKILL.md` is agent-facing content, not installer metadata.

The package manifest remains authoritative for skill identity, version, compatibility, declared files/resources/runtime, instruction fragment, and declared cleanup semantics.

## Interactive navigation

Run without an explicit command:

```text
JLS Installer v<version>

What would you like to do?
- Manage skills on the current path
- Manage skills on the global path
- Manage skills on a custom path
- Manage installer
```

The three skill scope choices enter the same management menu:

```text
What would you like to do?
- Install new skills
- Check for updates
- Uninstall existing skills
```

`Check for updates` and `Uninstall existing skills` are unavailable when no managed skill is installed at that scope.

Backspace returns one interactive step. Escape exits. No visible fake `Go back` or `Cancel` rows are added.

Prompt state remains process-local and scoped by operation/scope/step. Previously entered custom paths, cursors, and multiselect values are restored when still valid. Destructive confirmations do not remember a prior affirmative answer.

## Controls

Single select footer:

```text
↑/↓ navigate • Enter confirm • Backspace back • Esc exit
```

Multiselect footer:

```text
↑/↓ navigate • Space select • Enter confirm • A toggle all • Backspace back • Esc exit
```

`I` may remain as an undisclosed invert shortcut.

Lifecycle confirmations use a vertical single-select:

```text
Continue?
Yes
No
```

Install/update may begin on Yes. Destructive uninstall begins on No.

## Install new skills

### Skill picker

Prompt:

```text
Which skills would you like to install?
```

A catalog skill is disabled only when it is already installed on every detected supported harness for the selected scope.

If the skill is installed on only some detected harnesses, keep it selectable.

This is installation-presence logic, not version-update logic. Stale installed skills belong to `Check for updates`.

### Harness picker

After skill selection:

```text
Which AI harnesses should receive these skills?
```

Show only detected supported harnesses.

A harness is disabled only when every selected skill is already installed for that harness. If at least one selected skill is missing there, the harness remains selectable.

### Instruction integration

After harness selection, explain the applicable instruction files using adapter-owned filenames. Current examples are `AGENTS.md` and `CLAUDE.md`.

The explanation is generic and does not hardcode a particular skill.

Then present only selected skills that provide a managed instruction fragment:

```text
Which skills would you like to add to AGENTS.md and CLAUDE.md?
```

Instruction-capable skills are selected by default. Users may opt out individually.

The selected subset applies uniformly across selected harness instruction files. Do not create a harness-by-harness matrix.

Managed content uses skill-specific markers and preserves surrounding user content.

### Confirmation

Keep the summary concise:

```text
JLS Installer will install the following skills on your current path:
- Tasks
- Other Skill

Continue?
Yes
No
```

Adapt wording for global/custom path.

### Execution semantics

For each selected skill × selected harness target:

- missing: install it;
- current/newer with requested instruction-state mismatch: change only managed instruction configuration;
- already satisfied: do nothing;
- stale: do not update through `Install new skills`.

A newer installed skill is never downgraded.

Configuration-only work must not rewrite the skill/runtime simply to change managed instruction state.

Install does not perform semantic project initialization.

## Check for updates

The scope management menu exposes updates only when installed skills exist.

On entry show an activity indicator while release metadata is fetched.

If no applicable updates exist:

```text
No updates were found.
```

Then return to the scope management menu.

If updates exist:

```text
The following updates are available. Please select which you would like to install.
- Tasks  0.2.1 -> 0.3.0
```

Then show a concise summary and standard confirmation.

Update:

- operates only on already-installed targets;
- does not add a new harness;
- replaces the complete manifest-owned installed representation;
- preserves unrelated files and generated semantic/project data;
- preserves existing instruction-injection state unless an explicit CLI override is supplied;
- never downgrades a newer installed version.

## Uninstall existing skills

Prompt:

```text
Which skills would you like to uninstall?
```

Show only managed skills installed at the selected scope.

Bare-wizard uninstall removes the selected skill from every installed supported harness target at that selected scope. Explicit CLI `--agent` continues to narrow targets.

Uninstall removes:

- skill discovery/resource directory;
- harness-specific resources owned by that skill;
- matching installer-managed instruction block;
- final-harness scope-local skill tooling when no harness integration remains.

It preserves unrelated instruction content, harness parent directories, unrelated harness config, and generated data unless the integrated generated-data choice explicitly selects that data for removal.

## Generated data during uninstall

Generated-data cleanup is part of interactive skill uninstall. It is not a separate home-screen action.

After selecting skills, detect removable generated data only for those selected skills and only within the selected scope.

If detected:

```text
The following selected skills have generated data that can also be removed.
- Map (SurrealKV database with surviving intent information from a previous session)
- Tasks (Beads tasks/issues generated from a goal/intent)
```

Detected cleanup options are selected by default. Deselecting a skill preserves its generated data.

Confirmation explicitly states `Generated data: Remove` or `Generated data: Keep` for skills with detected generated data.

Deterministic CLI uninstall preserves generated data unless a future explicit cleanup CLI contract is accepted.

### Path-owned generated data

A skill may declare bounded path-owned generated data in `generated_data`:

```json
{
  "path": ".map",
  "marker": "project.json",
  "description": "SurrealKV database with surviving intent information from a previous session"
}
```

Rules:

- path is relative to selected scope;
- absolute paths and traversal are rejected;
- optional marker must positively identify the data;
- only the declared path is recursively removed;
- neighboring files remain untouched.

### Non-path cleanup

A skill may declare installer cleanup semantics that do not imply ownership of a filesystem directory through `generated_cleanup`.

Initial supported kind:

```json
{
  "kind": "beads-metadata",
  "description": "Beads tasks/issues generated from a goal/intent",
  "metadata_key": "jls-tasks",
  "metadata_value": "owned"
}
```

For `beads-metadata` cleanup:

- operate only on a Beads database found in the selected scope;
- query structured issue metadata using exact `key=value` filtering;
- verify each returned issue's structured metadata still contains the exact key/value;
- never infer ownership from title, description, notes, labels, comments, or other prose;
- re-query immediately before deletion;
- delete only the exact matching IDs;
- never delete the entire Beads database.

The installer may cache raw package manifests under installer-owned metadata so cleanup declarations remain available after package operations. That cache is not an installation receipt.

## Tasks provenance contract

Tasks-created Beads issues use exact structured metadata:

```json
{
  "jls-tasks": "owned"
}
```

Only newly created Tasks issues receive this marker.

A pre-existing issue that Tasks reuses or updates must not be marked Tasks-owned merely because Tasks touched it.

Tasks' Designer writes the marker with current live `bd create --metadata` syntax and reads it back. Tasks' final Reviewer verifies correct ownership marking.

## Managed instruction integration

Managed blocks use deterministic markers such as:

```md
<!-- jls:begin map -->
...
<!-- jls:end map -->
```

Required behavior:

- preserve unmanaged/user-authored content;
- create instruction files only when necessary;
- repeated install/update is idempotent;
- update only the matching owned block;
- allow independent blocks from multiple skills;
- use safe/atomic writes;
- reject malformed/duplicate/conflicting boundaries rather than guessing;
- uninstall removes only the matching managed block;
- if removal leaves the instruction file empty, retain the empty file;
- opting out leaves unrelated existing content untouched.

Instruction fragments render actual scope-local runtime paths where needed.

## Manage installer

Top-level `Manage installer` shows:

```text
What would you like to do?
- Check for updates
- Uninstall this installer
```

### Check for updates

Show an activity indicator while checking.

When current:

```text
Up to date.
```

Then return to installer management.

When newer:

```text
An update is available: v0.2.1 -> v0.3.0.

Updating will end this session. You must relaunch JLS afterward.

Continue?
Yes
No
```

No returns to installer management.

Yes downloads/verifies/stages/replaces the current-target executable and ends the session without post-confirm status narration.

Installer update preserves installed skills, skill runtimes/tooling, managed instruction integrations, and generated skill data.

### Uninstall this installer

Warning:

```text
This will uninstall the JLS installer and its installer-owned metadata and tooling. It will not remove installed skills, skill instruction integrations, skill runtimes, or skill-generated data.
```

Then use safe-default `Continue?`.

On Yes, a silent detached helper removes:

- installer executable;
- installer-owned cached metadata/tooling.

It preserves all skill-owned state and prints no post-confirm success/scheduling message.

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

Unknown future manifest fields may be ignored by older package parsing only when doing so is safe. A new cleanup declaration must never be represented as an unsafe fake filesystem path merely for backward compatibility.

## Release model

JLS builds only the installer. Skill repositories own skill packages/runtime builds.

Canonical installer targets:

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

Exact public filenames remain target-qualified.

The installer release manifest references externally owned skill release manifests. Artifact selection is exact current target first, then explicit `portable` fallback for skills only.

`manifest.json` in the JLS repository is the installer product/release version authority. `package.json` is not.

Changing `manifest.json` to a higher semantic version dispatches the stable release workflow. Ordinary implementation commits must not trigger stable release.

## Test build trigger

Normal pushes must not build every installer target.

A lightweight workflow listens for creation of an ephemeral branch matching:

```text
jls-test/**
```

For such a branch it:

1. dispatches existing `build.yml` on `main` with `action=build`;
2. does not publish a release;
3. deletes the ephemeral trigger branch.

The intended assistant workflow is:

1. complete and commit implementation work;
2. create one `jls-test/<unique>` branch at the final `main` commit;
3. report that the test build was triggered;
4. do not wait for or poll the build result.

No manifest version bump is required for a test build.

## 0.4 release boundary

The implementation target is JLS 0.4.0, but implementation/testing must not change the installer `manifest.json` version until explicit release approval.

The 0.4 stable build is triggered only by the later intentional manifest semantic-version increase.
