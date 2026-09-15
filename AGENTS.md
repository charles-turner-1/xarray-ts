# AGENTS.md

Guidance for AI coding agents working in this repository, whichever tool you are.

See [`CLAUDE.md`](./CLAUDE.md) for the core engineering rule — **xarray-ts mirrors
xarray 1:1; never "optimise" or second-guess it** — and the stacked-PR / verification
workflow. (That file also holds any Claude-specific notes; other agents can read it too,
but it is not required reading for them.) This file covers attribution, and applies to
every agent.

## Attribution

Anything an agent authors must make that authorship clear, using **that agent's own
identity** — do not attribute your work to a different tool.

- **Commits** end with a co-author trailer naming the agent (and model, when it has
  one): `Co-Authored-By: <Agent> <email>`.
- **Pull request** descriptions end with a one-line note that the PR was generated with
  the agent/tool.
- **Issues** — in this repo and in related repos you file on the project's behalf (e.g.
  `xrexpr`) — end with the same one-line "generated with" note.

The point is provenance: a reader should always be able to tell an artefact was
agent-generated, and by which agent. When in doubt, add the note rather than leave it
ambiguous. If your harness supplies its own attribution format for commits and PRs,
follow that; apply the same convention to issues, which harnesses don't generally cover.

For example, Claude Code uses a `Co-Authored-By: Claude …` commit trailer and ends PRs
and issues with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
Substitute your own tool's equivalent.
