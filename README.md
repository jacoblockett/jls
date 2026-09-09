# JLS

JLS is a cross-platform installer for a curated set of AI coding-agent skills. It handles downloading, installing, updating, and removing those skills for supported coding agents, currently OpenAI Codex and Claude Code.

## Skills

### [Map](https://github.com/jacoblockett/jls-map)

Map is a local, durable intent graph for preserving project goals, open questions, decisions, facts, and rationale across long-running agent work. It provides a structured clarification workflow so important context survives beyond a single conversation or context window.

### [Tasks](https://github.com/jacoblockett/jls-tasks)

Tasks exhaustively converts authoritative goals, specifications, plans, and structured source material into small, self-contained work items while preserving source coverage, provenance, constraints, and dependencies. It currently uses Beads as its native task backend.

## Install

Download the appropriate build from the [Releases page](https://github.com/jacoblockett/jls/releases) and run it.

On macOS or Linux, you may need to mark the downloaded file executable first:

```bash
chmod +x <downloaded-file>
```

## License

This project is licensed under the [MIT License](LICENSE). Copyright © 2026 Jacob Lockett.
