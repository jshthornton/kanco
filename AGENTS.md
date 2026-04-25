# Agent Guidelines

## Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/).

Format commit messages as:

```
<type>(<optional scope>): <description>
```

Common types:

- `feat` — a new feature
- `fix` — a bug fix
- `docs` — documentation only changes
- `style` — formatting, missing semicolons, etc. (no code change)
- `refactor` — code change that neither fixes a bug nor adds a feature
- `perf` — performance improvement
- `test` — adding or updating tests
- `build` — build system or external dependency changes
- `ci` — CI configuration changes
- `chore` — other changes that don't modify src or test files

Use `!` after the type/scope or a `BREAKING CHANGE:` footer to mark breaking changes.

## Pull Requests

When work on a branch is complete, push the branch and open a pull request automatically using the [`gh` CLI](https://cli.github.com/) rather than waiting for the user to do it manually.

Typical flow:

```
git push -u origin <branch>
gh pr create --fill
```

Use `--fill` to seed the title and body from the commit messages, or pass `--title` / `--body` explicitly when more context is needed. Target the default branch unless the ticket says otherwise.
