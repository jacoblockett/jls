# JLS

JLS is a cross-platform installer for a curated set of AI coding-agent skills. It handles downloading, installing, updating, and removing those skills for supported coding agents, currently OpenAI Codex and Claude Code.

## Skills

The curated skill set is defined only by the repository pointers in `catalog.json`. The compiled installer embeds those pointers and resolves each skill's name, description, dependencies, version, and release assets from the skill repository itself.

## Install

Download the appropriate build from the [Releases page](https://github.com/jacoblockett/jls/releases) and run it.

On macOS or Linux, you may need to mark the downloaded file executable first:

```bash
chmod +x <downloaded-file>
```

## License

This project is licensed under the [MIT License](LICENSE). Copyright © 2026 Jacob Lockett.
