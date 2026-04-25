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
